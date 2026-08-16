//! WebView2 process-failure recovery coordinator.
//!
//! wry's platform layer detects WebView2 child-process failures and surfaces
//! a structured [`WebView2ProcessFailedInfo`] signal (see
//! `vendor/wry/src/webview2/mod.rs`). This module owns the
//! *application-level* recovery policy: deciding whether a failure deserves a
//! renderer reload, an application restart, or nothing but diagnostics, and
//! executing the chosen action through Tauri APIs.
//!
//! The policy is deliberately a pure, deterministic state machine
//! ([`WebView2Recovery`]) so it can be unit-tested on any platform without a
//! Windows/WebView2 runtime; only [`install`] touches Tauri/wry.
//!
//! ## Kind policy (mirrors Microsoft's process-related-event guidance)
//!
//! - **Browser process exited**: fatal. Every control is closed and the
//!   environment is gone; a plain reload is ineffective. DBX restarts the
//!   application through the normal close flow so persisted state (open tabs,
//!   window geometry, saved SQL) survives and running queries are cancelled
//!   by `AppState::shutdown` (see `commands::connection`).
//! - **Main renderer exited**: confirmed renderer death — reload, bounded by
//!   the rolling budget below.
//! - **Renderer unresponsive**: the event can be raised repeatedly and the
//!   renderer may recover on its own, so DBX does **not** reload on the first
//!   event. Only once the event fires `unresponsive_threshold` times inside
//!   `unresponsive_window` does recovery trigger (still bounded by the same
//!   rolling budget).
//! - **GPU exited**: WebView2 restarts the GPU process on its own; no reload.
//! - **Subframe renderer exited**: recovery is per-frame; reloading the whole
//!   SPA would discard unsaved SQL / editor state for the whole window.
//! - **Utility / other**: log only, no destructive recovery.
//!
//! ## Reload budget (rolling, not lifetime-cumulative)
//!
//! At most `max_reloads_in_window` automatic reloads are allowed inside a
//! rolling `reload_window`; reloads older than the window stop counting, so a
//! long healthy period resets the budget and unrelated failures hours apart
//! never permanently disable recovery. A `reload_cooldown` additionally
//! deduplicates the burst of events a crash loop produces.
//!
//! ## Production visibility
//!
//! Every decision is appended to `webview2-recovery.log` next to `startup.log`
//! via [`crate::startup_recovery::record_runtime_recovery_event`]. That file
//! is not gated by the `debug_logging_enabled` setting (which turns the whole
//! `log` facade off in packaged builds), so fatal / exhausted / restart
//! decisions are always observable on affected Windows devices. The `log`
//! facade and `eprintln!` are used on top in debug builds.

use std::collections::VecDeque;
use std::time::Duration;

use wry::{WebView2ProcessFailedInfo, WebView2ProcessFailedKind};

/// What the application should do in response to a WebView2 process failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RecoveryAction {
    /// Reload the main webview (bounded by the rolling budget).
    Reload,
    /// Restart the whole application through the normal close flow.
    Restart,
    /// No destructive action; the event is still logged.
    LogOnly,
}

/// Why an event produced its action; used for diagnostics and tests.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RecoveryDetail {
    /// The browser process exited (fatal; every control is closed).
    BrowserProcessExited,
    /// The main renderer exited; confirmed death -> bounded reload.
    RendererProcessExited,
    /// Renderer unresponsive but not yet at the threshold; only armed.
    RendererUnresponsiveArmed { count: u32, threshold: u32 },
    /// Renderer unresponsive and the threshold was reached -> reload.
    RendererUnresponsiveTriggered { count: u32, threshold: u32 },
    /// The GPU process exited; WebView2 restarts it on its own.
    GpuProcessExited,
    /// A subframe renderer exited; a whole-SPA reload is not warranted.
    FrameRendererProcessExited,
    /// A utility or other process exited; no destructive recovery.
    OtherProcessExited,
    /// A reload was requested inside the cooldown window; skipped.
    ReloadThrottled,
    /// The rolling reload budget is exhausted; auto-recovery stops.
    ReloadBudgetExhausted { reloads: u32, window_secs: u64 },
}

/// Tunable constants of the recovery policy.
///
/// Every field has a documented policy purpose; they are kept as plain fields
/// (with [`Default`]) so tests can exercise boundary values directly.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct WebView2RecoveryPolicy {
    /// Minimum gap between two automatic reloads. Absorbs the burst of
    /// `ProcessFailed` events a crash loop produces so a single failure is not
    /// answered with a reload storm.
    pub reload_cooldown: Duration,
    /// Rolling window for the reload budget: reloads older than this stop
    /// counting, so a long healthy period resets the budget and unrelated
    /// failures hours apart never permanently disable recovery.
    pub reload_window: Duration,
    /// Maximum automatic reloads allowed inside [`Self::reload_window`]. Once
    /// the window is full, auto-recovery stops and the app relies on the user
    /// (the failure is logged; on Windows the recovery log records it).
    pub max_reloads_in_window: u32,
    /// Rolling window for renderer-unresponsive events.
    pub unresponsive_window: Duration,
    /// Renderer-unresponsive events inside [`Self::unresponsive_window`] that
    /// trigger a reload. The first event never reloads (the renderer may
    /// recover on its own); reaching this count means the renderer is
    /// effectively wedged.
    pub unresponsive_threshold: u32,
}

impl Default for WebView2RecoveryPolicy {
    fn default() -> Self {
        Self {
            reload_cooldown: Duration::from_secs(30),
            reload_window: Duration::from_secs(10 * 60),
            max_reloads_in_window: 3,
            unresponsive_window: Duration::from_secs(60),
            unresponsive_threshold: 3,
        }
    }
}

/// Deterministic recovery state machine. Owns nothing but counters, so it can
/// be driven with synthetic event streams in tests.
struct WebView2Recovery {
    policy: WebView2RecoveryPolicy,
    /// Unix millis of each automatic reload inside the rolling window.
    reload_timestamps: VecDeque<u64>,
    /// Unix millis of the last automatic reload; `0` = never reloaded.
    last_reload_at: u64,
    /// Start of the current unresponsive counting window.
    unresponsive_window_start: u64,
    /// Renderer-unresponsive events observed inside the current window.
    unresponsive_count: u32,
    /// Whether a browser-process-exit restart was already requested for this
    /// process. Guards against a second event double-restarting.
    browser_fatal_fired: bool,
}

impl WebView2Recovery {
    fn new(policy: WebView2RecoveryPolicy) -> Self {
        Self {
            policy,
            reload_timestamps: VecDeque::new(),
            last_reload_at: 0,
            unresponsive_window_start: 0,
            unresponsive_count: 0,
            browser_fatal_fired: false,
        }
    }

    /// Decides the recovery action for one `ProcessFailed` event.
    ///
    /// `now_ms` is a monotonic-ish Unix-millis clock (injected for tests).
    fn handle_process_failed(
        &mut self,
        info: &WebView2ProcessFailedInfo,
        now_ms: u64,
    ) -> (RecoveryAction, RecoveryDetail) {
        match info.kind {
            WebView2ProcessFailedKind::Browser => {
                if self.browser_fatal_fired {
                    (RecoveryAction::LogOnly, RecoveryDetail::BrowserProcessExited)
                } else {
                    self.browser_fatal_fired = true;
                    (RecoveryAction::Restart, RecoveryDetail::BrowserProcessExited)
                }
            }
            WebView2ProcessFailedKind::Renderer => {
                let outcome = self.budgeted_reload(now_ms);
                match outcome {
                    Ok(()) => (RecoveryAction::Reload, RecoveryDetail::RendererProcessExited),
                    Err(detail) => (RecoveryAction::LogOnly, detail),
                }
            }
            WebView2ProcessFailedKind::RendererUnresponsive => {
                let window_ms = self.policy.unresponsive_window.as_millis() as u64;
                if now_ms.saturating_sub(self.unresponsive_window_start) >= window_ms {
                    self.unresponsive_window_start = now_ms;
                    self.unresponsive_count = 0;
                }
                self.unresponsive_count += 1;
                let count = self.unresponsive_count;
                if count >= self.policy.unresponsive_threshold {
                    let outcome = self.budgeted_reload(now_ms);
                    // Reset the counter so post-reload evaluation starts fresh; the
                    // rolling reload budget still bounds a wedged-renderer crash loop.
                    self.unresponsive_count = 0;
                    match outcome {
                        Ok(()) => (
                            RecoveryAction::Reload,
                            RecoveryDetail::RendererUnresponsiveTriggered {
                                count,
                                threshold: self.policy.unresponsive_threshold,
                            },
                        ),
                        Err(detail) => (RecoveryAction::LogOnly, detail),
                    }
                } else {
                    (
                        RecoveryAction::LogOnly,
                        RecoveryDetail::RendererUnresponsiveArmed {
                            count,
                            threshold: self.policy.unresponsive_threshold,
                        },
                    )
                }
            }
            // WebView2 restarts the GPU process on its own; do not reload the SPA.
            WebView2ProcessFailedKind::Gpu => (RecoveryAction::LogOnly, RecoveryDetail::GpuProcessExited),
            // A subframe renderer exit only needs the affected frame; reloading the
            // whole SPA would discard unsaved SQL / editor state.
            WebView2ProcessFailedKind::FrameRenderer => {
                (RecoveryAction::LogOnly, RecoveryDetail::FrameRendererProcessExited)
            }
            _ => (RecoveryAction::LogOnly, RecoveryDetail::OtherProcessExited),
        }
    }

    /// Consumes one reload from the rolling budget.
    ///
    /// Returns [`Ok`] when the reload is allowed (recording its timestamp), or
    /// the reason it was denied (cooldown / budget exhausted).
    fn budgeted_reload(&mut self, now_ms: u64) -> Result<(), RecoveryDetail> {
        let cooldown_ms = self.policy.reload_cooldown.as_millis() as u64;
        if self.last_reload_at != 0 && now_ms.saturating_sub(self.last_reload_at) < cooldown_ms {
            return Err(RecoveryDetail::ReloadThrottled);
        }
        let window_ms = self.policy.reload_window.as_millis() as u64;
        // Drop reloads that fell out of the rolling window: a long healthy period
        // resets the budget.
        while let Some(&timestamp) = self.reload_timestamps.front() {
            if now_ms.saturating_sub(timestamp) >= window_ms {
                self.reload_timestamps.pop_front();
            } else {
                break;
            }
        }
        if self.reload_timestamps.len() >= self.policy.max_reloads_in_window as usize {
            return Err(RecoveryDetail::ReloadBudgetExhausted {
                reloads: self.reload_timestamps.len() as u32,
                window_secs: self.policy.reload_window.as_secs(),
            });
        }
        self.reload_timestamps.push_back(now_ms);
        self.last_reload_at = now_ms;
        Ok(())
    }
}

fn now_unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn recovery_log_message(action: RecoveryAction, detail: RecoveryDetail, info: &WebView2ProcessFailedInfo) -> String {
    format!(
        "webview2 recovery decision={action:?} detail={detail:?} kind={:?} reason={} exit_code={} process={} frames={}",
        info.kind,
        info.reason.as_deref().unwrap_or("-"),
        info.exit_code.map(|code| code.to_string()).unwrap_or_else(|| "-".to_string()),
        info.process_description.as_deref().unwrap_or("-"),
        info.affected_frames,
    )
}

/// Installs the WebView2 process-failure handler for this application.
///
/// Must be called once during Tauri setup on Windows. The callback receives
/// every `ProcessFailed` event from the (single) main webview, applies the
/// recovery policy, records a production-visible log line, and executes the
/// action:
///
/// - `Restart` → [`tauri::AppHandle::request_restart`], which runs the normal
///   close flow (`RunEvent::ExitRequested` → [`AppState::shutdown`] cancels
///   running queries and closes pools/tunnels) before Tauri respawns the
///   process. Persisted state (open tabs incl. unsaved SQL, window geometry,
///   saved SQL library) survives the restart.
/// - `Reload` → reloads the `main` webview on the main thread.
/// - `LogOnly` → nothing but the log line.
#[cfg(target_os = "windows")]
pub fn install(app: &tauri::AppHandle) {
    use std::sync::{Arc, LazyLock, Mutex};

    use tauri::Manager;
    use wry::WebView2ProcessFailedCallback;

    static RECOVERY: LazyLock<Mutex<WebView2Recovery>> =
        LazyLock::new(|| Mutex::new(WebView2Recovery::new(WebView2RecoveryPolicy::default())));

    let app = app.clone();
    let callback: WebView2ProcessFailedCallback = Arc::new(move |info| {
        let (action, detail) = {
            let mut recovery = RECOVERY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            recovery.handle_process_failed(info, now_unix_millis())
        };
        let message = recovery_log_message(action, detail, info);
        crate::startup_recovery::record_runtime_recovery_event(&message);
        log::error!("{message}");
        eprintln!("{message}");
        match action {
            RecoveryAction::Restart => {
                // Full close flow: `ExitRequested` runs `AppState::shutdown` (cancels
                // running queries, closes pools/tunnels/daemons) before Tauri
                // respawns the process, so the restart is not a raw kill.
                app.request_restart();
            }
            RecoveryAction::Reload => {
                let reload_app = app.clone();
                let _ = app.run_on_main_thread(move || {
                    if let Some(window) = reload_app.get_webview_window("main") {
                        let _ = window.reload();
                    }
                });
            }
            RecoveryAction::LogOnly => {}
        }
    });
    wry::set_webview2_process_failed_callback(Some(callback));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy_with(
        reload_cooldown: Duration,
        reload_window: Duration,
        max_reloads: u32,
        unresponsive_window: Duration,
        unresponsive_threshold: u32,
    ) -> WebView2RecoveryPolicy {
        WebView2RecoveryPolicy {
            reload_cooldown,
            reload_window,
            max_reloads_in_window: max_reloads,
            unresponsive_window,
            unresponsive_threshold,
        }
    }

    fn info(kind: WebView2ProcessFailedKind) -> WebView2ProcessFailedInfo {
        WebView2ProcessFailedInfo { kind, reason: None, exit_code: None, process_description: None, affected_frames: 0 }
    }

    #[test]
    fn browser_process_exit_requests_a_restart() {
        let mut recovery = WebView2Recovery::new(WebView2RecoveryPolicy::default());
        assert_eq!(
            recovery.handle_process_failed(&info(WebView2ProcessFailedKind::Browser), 1_000),
            (RecoveryAction::Restart, RecoveryDetail::BrowserProcessExited)
        );
    }

    #[test]
    fn browser_process_exit_never_restarts_twice() {
        let mut recovery = WebView2Recovery::new(WebView2RecoveryPolicy::default());
        let first = recovery.handle_process_failed(&info(WebView2ProcessFailedKind::Browser), 1_000);
        assert_eq!(first.0, RecoveryAction::Restart);
        let second = recovery.handle_process_failed(&info(WebView2ProcessFailedKind::Browser), 1_001);
        assert_eq!(second.0, RecoveryAction::LogOnly);
    }

    #[test]
    fn renderer_exit_reloads_within_budget() {
        let mut recovery = WebView2Recovery::new(WebView2RecoveryPolicy::default());
        assert_eq!(
            recovery.handle_process_failed(&info(WebView2ProcessFailedKind::Renderer), 1_000),
            (RecoveryAction::Reload, RecoveryDetail::RendererProcessExited)
        );
    }

    #[test]
    fn renderer_exit_is_throttled_inside_the_cooldown() {
        let mut recovery = WebView2Recovery::new(policy_with(
            Duration::from_secs(30),
            Duration::from_secs(600),
            3,
            Duration::from_secs(60),
            3,
        ));
        assert_eq!(
            recovery.handle_process_failed(&info(WebView2ProcessFailedKind::Renderer), 1_000).0,
            RecoveryAction::Reload
        );
        assert_eq!(
            recovery.handle_process_failed(&info(WebView2ProcessFailedKind::Renderer), 1_100).0,
            RecoveryAction::LogOnly
        );
        assert_eq!(
            recovery.handle_process_failed(&info(WebView2ProcessFailedKind::Renderer), 1_100).1,
            RecoveryDetail::ReloadThrottled
        );
    }

    #[test]
    fn first_unresponsive_event_never_reloads() {
        let mut recovery = WebView2Recovery::new(WebView2RecoveryPolicy::default());
        let (action, detail) =
            recovery.handle_process_failed(&info(WebView2ProcessFailedKind::RendererUnresponsive), 1_000);
        assert_eq!(action, RecoveryAction::LogOnly);
        assert_eq!(detail, RecoveryDetail::RendererUnresponsiveArmed { count: 1, threshold: 3 });
    }

    #[test]
    fn unresponsive_reloads_only_after_the_threshold() {
        let mut recovery = WebView2Recovery::new(WebView2RecoveryPolicy::default());
        for (now, expected_count) in [(1_000u64, 1u32), (20_000, 2)] {
            let (action, detail) =
                recovery.handle_process_failed(&info(WebView2ProcessFailedKind::RendererUnresponsive), now);
            assert_eq!(action, RecoveryAction::LogOnly);
            assert_eq!(detail, RecoveryDetail::RendererUnresponsiveArmed { count: expected_count, threshold: 3 });
        }
        // The third event inside the unresponsive window (60s) reaches the
        // threshold and triggers the bounded reload.
        let (action, detail) =
            recovery.handle_process_failed(&info(WebView2ProcessFailedKind::RendererUnresponsive), 40_000);
        assert_eq!(action, RecoveryAction::Reload);
        assert_eq!(detail, RecoveryDetail::RendererUnresponsiveTriggered { count: 3, threshold: 3 });
        // The counter is reset after the triggered reload, so post-reload
        // evaluation starts fresh instead of re-triggering immediately.
        let (action, detail) =
            recovery.handle_process_failed(&info(WebView2ProcessFailedKind::RendererUnresponsive), 50_000);
        assert_eq!(action, RecoveryAction::LogOnly);
        assert_eq!(detail, RecoveryDetail::RendererUnresponsiveArmed { count: 1, threshold: 3 });
    }

    #[test]
    fn unresponsive_counter_expires_with_the_window() {
        let mut recovery = WebView2Recovery::new(policy_with(
            Duration::from_secs(30),
            Duration::from_secs(600),
            3,
            Duration::from_secs(60),
            3,
        ));
        recovery.handle_process_failed(&info(WebView2ProcessFailedKind::RendererUnresponsive), 1_000);
        recovery.handle_process_failed(&info(WebView2ProcessFailedKind::RendererUnresponsive), 20_000);
        // The unresponsive window expired: counting starts fresh, so this event
        // must not reach the threshold.
        let (action, detail) =
            recovery.handle_process_failed(&info(WebView2ProcessFailedKind::RendererUnresponsive), 120_000);
        assert_eq!(action, RecoveryAction::LogOnly);
        assert_eq!(detail, RecoveryDetail::RendererUnresponsiveArmed { count: 1, threshold: 3 });
    }

    #[test]
    fn gpu_exit_never_reloads() {
        let mut recovery = WebView2Recovery::new(WebView2RecoveryPolicy::default());
        let (action, detail) = recovery.handle_process_failed(&info(WebView2ProcessFailedKind::Gpu), 1_000);
        assert_eq!(action, RecoveryAction::LogOnly);
        assert_eq!(detail, RecoveryDetail::GpuProcessExited);
    }

    #[test]
    fn frame_renderer_exit_never_reloads_the_whole_webview() {
        let mut recovery = WebView2Recovery::new(WebView2RecoveryPolicy::default());
        let (action, detail) = recovery.handle_process_failed(&info(WebView2ProcessFailedKind::FrameRenderer), 1_000);
        assert_eq!(action, RecoveryAction::LogOnly);
        assert_eq!(detail, RecoveryDetail::FrameRendererProcessExited);
    }

    #[test]
    fn utility_and_unknown_exits_only_log() {
        let mut recovery = WebView2Recovery::new(WebView2RecoveryPolicy::default());
        for kind in [
            WebView2ProcessFailedKind::Utility,
            WebView2ProcessFailedKind::SandboxHelper,
            WebView2ProcessFailedKind::PpapiPlugin,
            WebView2ProcessFailedKind::PpapiBroker,
            WebView2ProcessFailedKind::Unknown,
        ] {
            let (action, detail) = recovery.handle_process_failed(&info(kind), 1_000);
            assert_eq!(action, RecoveryAction::LogOnly, "{kind:?}");
            assert_eq!(detail, RecoveryDetail::OtherProcessExited, "{kind:?}");
        }
    }

    #[test]
    fn burst_failures_consume_the_budget_inside_the_window() {
        let mut recovery = WebView2Recovery::new(policy_with(
            Duration::from_secs(30),
            Duration::from_secs(600),
            3,
            Duration::from_secs(60),
            3,
        ));
        // Three unrelated renderer exits spaced past the cooldown but inside the
        // rolling window.
        for now in [0, 60_000, 120_000] {
            assert_eq!(
                recovery.handle_process_failed(&info(WebView2ProcessFailedKind::Renderer), now).0,
                RecoveryAction::Reload
            );
        }
        // Fourth failure inside the window: budget exhausted.
        let (action, detail) = recovery.handle_process_failed(&info(WebView2ProcessFailedKind::Renderer), 180_000);
        assert_eq!(action, RecoveryAction::LogOnly);
        assert_eq!(detail, RecoveryDetail::ReloadBudgetExhausted { reloads: 3, window_secs: 600 });
    }

    #[test]
    fn long_stable_period_resets_the_budget() {
        let mut recovery = WebView2Recovery::new(policy_with(
            Duration::from_secs(30),
            Duration::from_secs(600),
            3,
            Duration::from_secs(60),
            3,
        ));
        for now in [0, 60_000, 120_000] {
            assert_eq!(
                recovery.handle_process_failed(&info(WebView2ProcessFailedKind::Renderer), now).0,
                RecoveryAction::Reload
            );
        }
        // All reloads are older than the rolling window now: budget is reset, a
        // fresh failure recovers again instead of being permanently disabled.
        let (action, _) = recovery.handle_process_failed(&info(WebView2ProcessFailedKind::Renderer), 180_000 + 600_000);
        assert_eq!(action, RecoveryAction::Reload);
    }

    #[test]
    fn unrelated_failures_hours_apart_do_not_deplete_the_lifetime_budget() {
        let mut recovery = WebView2Recovery::new(policy_with(
            Duration::from_secs(30),
            Duration::from_secs(600),
            3,
            Duration::from_secs(60),
            3,
        ));
        // One failure every hour, far apart: every one recovers; nothing is
        // permanently consumed.
        for hour in 0..10 {
            let now = hour * 3_600_000;
            assert_eq!(
                recovery.handle_process_failed(&info(WebView2ProcessFailedKind::Renderer), now).0,
                RecoveryAction::Reload
            );
        }
    }

    #[test]
    fn exhausted_budget_never_auto_reloads_until_the_window_rolls_over() {
        let mut recovery = WebView2Recovery::new(policy_with(
            Duration::from_secs(30),
            Duration::from_secs(600),
            3,
            Duration::from_secs(60),
            3,
        ));
        for now in [0, 60_000, 120_000] {
            assert_eq!(
                recovery.handle_process_failed(&info(WebView2ProcessFailedKind::Renderer), now).0,
                RecoveryAction::Reload
            );
        }
        // Still inside the window: exhausted.
        assert_eq!(
            recovery.handle_process_failed(&info(WebView2ProcessFailedKind::Renderer), 180_000).0,
            RecoveryAction::LogOnly
        );
        // Just past the window edge: the oldest reload expired, one slot frees.
        assert_eq!(
            recovery.handle_process_failed(&info(WebView2ProcessFailedKind::Renderer), 600_000 + 1).0,
            RecoveryAction::Reload
        );
    }

    #[test]
    fn unresponsive_triggered_reload_consumes_the_budget() {
        let mut recovery = WebView2Recovery::new(policy_with(
            Duration::from_secs(30),
            Duration::from_secs(600),
            1,
            Duration::from_secs(60),
            3,
        ));
        // Unresponsive events alone do not consume the reload budget until the
        // third event reaches the threshold.
        for now in [1_000, 20_000] {
            assert_eq!(
                recovery.handle_process_failed(&info(WebView2ProcessFailedKind::RendererUnresponsive), now).0,
                RecoveryAction::LogOnly
            );
        }
        // Threshold reached -> reload, consuming the only reload slot.
        let (action, detail) =
            recovery.handle_process_failed(&info(WebView2ProcessFailedKind::RendererUnresponsive), 40_000);
        assert_eq!(action, RecoveryAction::Reload);
        assert_eq!(detail, RecoveryDetail::RendererUnresponsiveTriggered { count: 3, threshold: 3 });
        // A renderer crash after the cooldown elapses is blocked by the
        // exhausted budget (the reload happened inside the rolling window).
        let (action, detail) = recovery.handle_process_failed(&info(WebView2ProcessFailedKind::Renderer), 80_000);
        assert_eq!(action, RecoveryAction::LogOnly);
        assert_eq!(detail, RecoveryDetail::ReloadBudgetExhausted { reloads: 1, window_secs: 600 });
    }

    #[test]
    fn recovery_log_message_includes_kind_and_action() {
        let mut info = info(WebView2ProcessFailedKind::Renderer);
        info.reason = Some("crashed".to_string());
        info.exit_code = Some(-1);
        info.process_description = Some("renderer".to_string());
        info.affected_frames = 2;
        let message = recovery_log_message(RecoveryAction::Reload, RecoveryDetail::RendererProcessExited, &info);
        assert!(message.contains("decision=Reload"));
        assert!(message.contains("detail=RendererProcessExited"));
        assert!(message.contains("kind=Renderer"));
        assert!(message.contains("reason=crashed"));
        assert!(message.contains("exit_code=-1"));
        assert!(message.contains("frames=2"));
    }
}

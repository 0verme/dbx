export type BatchColumnSelectionMode = "select" | "insert";

export function batchColumnSelectionColumnList(candidates: string[], mode: BatchColumnSelectionMode, qualifier?: string): string {
  return candidates.map((candidate, index) => (mode === "select" && qualifier && index > 0 ? `${qualifier}.${candidate}` : candidate)).join(", ");
}

export function shouldResolveSqlColumnCompletion(options: { suggestColumns: boolean; hasReferencedTables: boolean; prefix: string; typedActivation: boolean; selectListColumnContext: boolean }): boolean {
  return options.suggestColumns && options.hasReferencedTables && (options.prefix.length > 0 || options.typedActivation || options.selectListColumnContext);
}

/**
 * The INSERT batch action writes its own closing parenthesis before VALUES.
 * Consume an existing one (normally inserted by CodeMirror's auto-close
 * brackets extension) so the resulting statement has exactly one `)`.
 */
export function batchColumnSelectionReplaceTo(options: { to: number; mode: BatchColumnSelectionMode; nextCharacter: string; replaceClosingQuote?: string }): number {
  const { to, mode, nextCharacter, replaceClosingQuote } = options;
  return replaceClosingQuote === nextCharacter || (mode === "insert" && nextCharacter === ")") ? to + 1 : to;
}

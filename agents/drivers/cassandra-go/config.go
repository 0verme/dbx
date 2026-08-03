package main

import (
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	gocql "github.com/apache/cassandra-gocql-driver/v2"
)

type cassandraConfig struct {
	hosts                    []string
	port                     int
	keyspace                 string
	username                 string
	password                 string
	localDatacenter          string
	requestTimeout           time.Duration
	connectTimeout           time.Duration
	protocolVersion          int
	consistency              string
	serialConsistency        string
	numConnections           int
	pageSize                 int
	cqlVersion               string
	ssl                      bool
	caCertPath               string
	clientCertPath           string
	clientKeyPath            string
	hostVerification         bool
	tcpNoDelay               bool
	keepAlive                bool
	debug                    bool
	retryPolicy              string
	retryCount               int
	reconnectionPolicy       string
	reconnectionBaseDelay    time.Duration
	reconnectionMaxDelay     time.Duration
	loadBalancingPolicy      string
	disableInitialHostLookup bool
}

func parseCassandraConfig(cp connectParams) (cassandraConfig, error) {
	config := cassandraConfig{
		port:                  9042,
		keyspace:              strings.TrimSpace(cp.Database),
		username:              cp.Username,
		password:              cp.Password,
		requestTimeout:        11 * time.Second,
		connectTimeout:        defaultConnectTimeout,
		numConnections:        2,
		pageSize:              5000,
		ssl:                   cp.SSL,
		caCertPath:            cp.CACertPath,
		clientCertPath:        cp.ClientCertPath,
		clientKeyPath:         cp.ClientKeyPath,
		hostVerification:      true,
		tcpNoDelay:            true,
		retryCount:            3,
		reconnectionBaseDelay: time.Second,
		reconnectionMaxDelay:  60 * time.Second,
	}
	if cp.Port > 0 {
		config.port = cp.Port
	}

	params := url.Values{}
	if strings.TrimSpace(cp.ConnectionString) != "" {
		if err := applyConnectionString(&config, params, cp.ConnectionString); err != nil {
			return cassandraConfig{}, err
		}
	}
	if len(config.hosts) == 0 {
		config.hosts = splitHosts(cp.Host)
	}
	if len(config.hosts) == 0 {
		return cassandraConfig{}, fmt.Errorf("Cassandra host is required")
	}

	urlParams, err := parseURLParams(cp.URLParams)
	if err != nil {
		return cassandraConfig{}, err
	}
	for key, values := range urlParams {
		params[key] = values
	}
	if err := applyCassandraURLParams(&config, params); err != nil {
		return cassandraConfig{}, err
	}
	if !config.disableInitialHostLookup && allLoopbackHosts(config.hosts) {
		config.disableInitialHostLookup = true
	}
	return config, nil
}

func applyConnectionString(config *cassandraConfig, params url.Values, raw string) error {
	value := strings.TrimSpace(raw)
	value = strings.TrimPrefix(value, "jdbc:")
	if !strings.Contains(value, "://") {
		return fmt.Errorf("unsupported Cassandra connection string: %s", raw)
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return fmt.Errorf("invalid Cassandra connection string: %w", err)
	}
	if parsed.Scheme != "cassandra" {
		return fmt.Errorf("unsupported Cassandra connection scheme: %s", parsed.Scheme)
	}
	if parsed.User != nil {
		config.username = parsed.User.Username()
		if password, ok := parsed.User.Password(); ok {
			config.password = password
		}
	}
	config.hosts = splitHosts(parsed.Host)
	if port := parsed.Port(); port != "" {
		parsedPort, parseErr := strconv.Atoi(port)
		if parseErr != nil || parsedPort < 1 || parsedPort > 65535 {
			return fmt.Errorf("invalid Cassandra port: %s", port)
		}
		config.port = parsedPort
	}
	if keyspace := strings.Trim(strings.TrimSpace(parsed.Path), "/"); keyspace != "" {
		config.keyspace = keyspace
	}
	for key, values := range parsed.Query() {
		params[key] = values
	}
	return nil
}

func parseURLParams(raw string) (url.Values, error) {
	raw = strings.TrimPrefix(strings.TrimSpace(raw), "?")
	if raw == "" {
		return url.Values{}, nil
	}
	values, err := url.ParseQuery(raw)
	if err != nil {
		return nil, fmt.Errorf("invalid Cassandra URL parameters: %w", err)
	}
	return values, nil
}

func applyCassandraURLParams(config *cassandraConfig, params url.Values) error {
	for rawKey, values := range params {
		if len(values) == 0 {
			continue
		}
		key := normalizeOptionName(rawKey)
		value := strings.TrimSpace(values[len(values)-1])
		switch key {
		case "localdatacenter", "datacenter", "dc":
			config.localDatacenter = value
		case "requesttimeout", "timeout":
			duration, err := parseDurationOption(value)
			if err != nil {
				return fmt.Errorf("invalid requesttimeout: %w", err)
			}
			config.requestTimeout = duration
		case "connecttimeout", "logintimeout":
			duration, err := parseDurationOption(value)
			if err != nil {
				return fmt.Errorf("invalid connecttimeout: %w", err)
			}
			config.connectTimeout = duration
		case "protocolversion", "protoversion":
			version, err := strconv.Atoi(value)
			if err != nil || version < 3 || version > 5 {
				return fmt.Errorf("protocolversion must be between 3 and 5")
			}
			config.protocolVersion = version
		case "consistency":
			if _, err := gocql.ParseConsistencyWrapper(value); err != nil {
				return err
			}
			config.consistency = value
		case "serialconsistency":
			consistency, err := gocql.ParseConsistencyWrapper(value)
			if err != nil {
				return err
			}
			if consistency != gocql.Serial && consistency != gocql.LocalSerial {
				return fmt.Errorf("serialconsistency must be SERIAL or LOCAL_SERIAL")
			}
			config.serialConsistency = value
		case "numconns", "connectionsperhost":
			count, err := strconv.Atoi(value)
			if err != nil || count < 1 || count > 32 {
				return fmt.Errorf("numconns must be between 1 and 32")
			}
			config.numConnections = count
		case "pagesize", "fetchsize":
			size, err := strconv.Atoi(value)
			if err != nil || size < 1 {
				return fmt.Errorf("pagesize must be positive")
			}
			config.pageSize = size
		case "cqlversion":
			config.cqlVersion = value
		case "ssl", "enablessl":
			enabled, err := strconv.ParseBool(value)
			if err != nil {
				return fmt.Errorf("invalid ssl option: %w", err)
			}
			config.ssl = enabled
		case "hostverification", "verifyhostname", "sslhostnameverification", "hostnameverification":
			enabled, err := strconv.ParseBool(value)
			if err != nil {
				return fmt.Errorf("invalid host verification option: %w", err)
			}
			config.hostVerification = enabled
		case "tcpnodelay":
			enabled, err := strconv.ParseBool(value)
			if err != nil {
				return fmt.Errorf("invalid tcpnodelay option: %w", err)
			}
			config.tcpNoDelay = enabled
		case "keepalive":
			enabled, err := strconv.ParseBool(value)
			if err != nil {
				return fmt.Errorf("invalid keepalive option: %w", err)
			}
			config.keepAlive = enabled
		case "user":
			config.username = value
		case "password":
			config.password = value
		case "debug":
			enabled, err := strconv.ParseBool(value)
			if err != nil {
				return fmt.Errorf("invalid debug option: %w", err)
			}
			config.debug = enabled
		case "retries":
			count, err := strconv.Atoi(value)
			if err != nil || count < 0 || count > 1000 {
				return fmt.Errorf("retries must be between 0 and 1000")
			}
			config.retryCount = count
		case "retry":
			policy, err := normalizeRetryPolicy(value)
			if err != nil {
				return err
			}
			config.retryPolicy = policy
		case "reconnection":
			policy, baseDelay, maxDelay, err := parseReconnectionPolicy(value)
			if err != nil {
				return err
			}
			config.reconnectionPolicy = policy
			config.reconnectionBaseDelay = baseDelay
			config.reconnectionMaxDelay = maxDelay
		case "disableinitialhostlookup":
			disabled, err := strconv.ParseBool(value)
			if err != nil {
				return fmt.Errorf("invalid disableinitialhostlookup option: %w", err)
			}
			config.disableInitialHostLookup = disabled
		case "loadbalancing":
			policy, err := normalizeLoadBalancingPolicy(value)
			if err != nil {
				return err
			}
			config.loadBalancingPolicy = policy
		case "sslenginefactory":
			if value != "" && !strings.EqualFold(simpleClassName(value), "DefaultSslEngineFactory") {
				return fmt.Errorf("custom Cassandra sslenginefactory is not supported by the native agent: %s", value)
			}
			config.ssl = true
		case "usekrb5":
			enabled, err := strconv.ParseBool(value)
			if err != nil {
				return fmt.Errorf("invalid usekrb5 option: %w", err)
			}
			if enabled {
				return fmt.Errorf("Cassandra Kerberos authentication is not supported by the native agent")
			}
		case "secureconnectbundle":
			if value != "" {
				return fmt.Errorf("Cassandra secure connect bundles are not supported by the native agent")
			}
		case "configfile":
			if value != "" {
				return fmt.Errorf("Cassandra Java driver configfile is not supported; translate it to native URL parameters")
			}
		case "compliancemode":
			// JDBC compliance modes only alter java.sql behavior. The native DBX
			// JSON-RPC contract already defines statement and transaction behavior.
		default:
			return fmt.Errorf("unsupported Cassandra URL parameter: %s", rawKey)
		}
	}
	return nil
}

func (config cassandraConfig) clusterConfig(keyspace string) (*gocql.ClusterConfig, error) {
	cluster := gocql.NewCluster(config.hosts...)
	cluster.Port = config.port
	cluster.Keyspace = strings.TrimSpace(keyspace)
	cluster.Timeout = config.requestTimeout
	cluster.ConnectTimeout = config.connectTimeout
	cluster.WriteTimeout = config.requestTimeout
	cluster.NumConns = config.numConnections
	cluster.PageSize = config.pageSize
	cluster.Dialer = cassandraDialer{
		timeout:    config.connectTimeout,
		keepAlive:  config.keepAlive,
		tcpNoDelay: config.tcpNoDelay,
	}
	cluster.DisableInitialHostLookup = config.disableInitialHostLookup
	cluster.IgnorePeerAddr = config.disableInitialHostLookup
	if config.protocolVersion != 0 {
		cluster.ProtoVersion = config.protocolVersion
	}
	if config.cqlVersion != "" {
		cluster.CQLVersion = config.cqlVersion
	}
	if config.consistency != "" {
		consistency, err := gocql.ParseConsistencyWrapper(config.consistency)
		if err != nil {
			return nil, err
		}
		cluster.Consistency = consistency
	}
	if config.serialConsistency != "" {
		consistency, err := gocql.ParseConsistencyWrapper(config.serialConsistency)
		if err != nil {
			return nil, err
		}
		cluster.SerialConsistency = consistency
	}
	if config.username != "" {
		cluster.Authenticator = gocql.PasswordAuthenticator{Username: config.username, Password: config.password}
	}
	if config.ssl {
		cluster.SslOpts = &gocql.SslOptions{
			CaPath:                 config.caCertPath,
			CertPath:               config.clientCertPath,
			KeyPath:                config.clientKeyPath,
			EnableHostVerification: config.hostVerification,
		}
	}
	if config.debug {
		cluster.Logger = gocql.NewLogger(gocql.LogLevelDebug)
	}
	if err := applyRetryPolicies(cluster, config); err != nil {
		return nil, err
	}
	if err := applyLoadBalancingPolicy(cluster, config); err != nil {
		return nil, err
	}
	return cluster, nil
}

func splitHosts(raw string) []string {
	raw = strings.ReplaceAll(raw, "--", ",")
	parts := strings.FieldsFunc(raw, func(char rune) bool { return char == ',' || char == ';' })
	hosts := make([]string, 0, len(parts))
	for _, part := range parts {
		host := strings.TrimSpace(part)
		if host == "" {
			continue
		}
		hosts = append(hosts, host)
	}
	return hosts
}

func allLoopbackHosts(hosts []string) bool {
	for _, host := range hosts {
		host = hostNameOnly(host)
		if strings.EqualFold(host, "localhost") {
			continue
		}
		ip := net.ParseIP(host)
		if ip == nil || !ip.IsLoopback() {
			return false
		}
	}
	return len(hosts) > 0
}

func hostNameOnly(host string) string {
	host = strings.TrimSpace(host)
	if parsedHost, _, err := net.SplitHostPort(host); err == nil {
		return parsedHost
	}
	return strings.Trim(host, "[]")
}

func parseDurationOption(value string) (time.Duration, error) {
	if duration, err := time.ParseDuration(value); err == nil {
		return duration, nil
	}
	milliseconds, err := strconv.Atoi(value)
	if err != nil || milliseconds < 1 {
		return 0, fmt.Errorf("expected duration or positive milliseconds")
	}
	return time.Duration(milliseconds) * time.Millisecond, nil
}

func normalizeRetryPolicy(value string) (string, error) {
	name := strings.ToLower(simpleClassName(value))
	switch name {
	case "", "defaultretrypolicy", "simpleretrypolicy":
		return "simple", nil
	case "fallthroughretrypolicy":
		return "fallthrough", nil
	case "downgradingconsistencyretrypolicy":
		return "downgrading", nil
	case "exponentialbackoffretrypolicy":
		return "exponential", nil
	default:
		return "", fmt.Errorf("unsupported Cassandra retry policy: %s", value)
	}
}

func normalizeLoadBalancingPolicy(value string) (string, error) {
	name := strings.ToLower(simpleClassName(value))
	switch name {
	case "", "dcinferringloadbalancingpolicy", "defaultloadbalancingpolicy":
		return "default", nil
	case "roundrobinpolicy":
		return "round_robin", nil
	case "dcawareroundrobinpolicy":
		return "dc_aware", nil
	case "tokenawarepolicy":
		return "token_aware", nil
	default:
		return "", fmt.Errorf("unsupported Cassandra loadbalancing policy: %s", value)
	}
}

func parseReconnectionPolicy(value string) (string, time.Duration, time.Duration, error) {
	trimmed := strings.TrimSpace(value)
	name := simpleClassName(trimmed)
	parameters := ""
	if open := strings.IndexByte(name, '('); open >= 0 {
		parameters = strings.TrimSuffix(name[open+1:], ")")
		name = name[:open]
	}
	policy := strings.ToLower(strings.TrimSpace(name))
	baseDelay := time.Second
	maxDelay := 60 * time.Second
	if parameters != "" {
		parts := strings.Split(parameters, ",")
		for index, part := range parts {
			part = strings.TrimSpace(strings.ReplaceAll(strings.ToLower(part), "(long)", ""))
			seconds, err := strconv.Atoi(part)
			if err != nil || seconds < 0 {
				return "", 0, 0, fmt.Errorf("invalid Cassandra reconnection policy delay: %s", part)
			}
			if index == 0 {
				baseDelay = time.Duration(seconds) * time.Second
			} else if index == 1 {
				maxDelay = time.Duration(seconds) * time.Second
			} else {
				return "", 0, 0, fmt.Errorf("too many Cassandra reconnection policy parameters")
			}
		}
	}
	switch policy {
	case "", "constantreconnectionpolicy":
		return "constant", baseDelay, baseDelay, nil
	case "exponentialreconnectionpolicy":
		return "exponential", baseDelay, maxDelay, nil
	default:
		return "", 0, 0, fmt.Errorf("unsupported Cassandra reconnection policy: %s", value)
	}
}

func simpleClassName(value string) string {
	value = strings.TrimSpace(value)
	prefix := value
	if open := strings.IndexByte(prefix, '('); open >= 0 {
		prefix = prefix[:open]
	}
	if dot := strings.LastIndexByte(prefix, '.'); dot >= 0 {
		return value[dot+1:]
	}
	return value
}

func applyRetryPolicies(cluster *gocql.ClusterConfig, config cassandraConfig) error {
	switch config.retryPolicy {
	case "":
	case "simple":
		cluster.RetryPolicy = &gocql.SimpleRetryPolicy{NumRetries: config.retryCount}
	case "fallthrough":
		cluster.RetryPolicy = &gocql.SimpleRetryPolicy{NumRetries: 0}
	case "downgrading":
		cluster.RetryPolicy = &gocql.DowngradingConsistencyRetryPolicy{}
	case "exponential":
		cluster.RetryPolicy = &gocql.ExponentialBackoffRetryPolicy{
			NumRetries: config.retryCount,
			Min:        config.reconnectionBaseDelay,
			Max:        config.reconnectionMaxDelay,
		}
	default:
		return fmt.Errorf("unsupported Cassandra retry policy: %s", config.retryPolicy)
	}
	if config.reconnectionPolicy != "" || config.retryCount != 3 {
		switch config.reconnectionPolicy {
		case "", "constant":
			cluster.ReconnectionPolicy = &gocql.ConstantReconnectionPolicy{
				MaxRetries: config.retryCount,
				Interval:   config.reconnectionBaseDelay,
			}
		case "exponential":
			cluster.ReconnectionPolicy = &gocql.ExponentialReconnectionPolicy{
				MaxRetries:      config.retryCount,
				InitialInterval: config.reconnectionBaseDelay,
				MaxInterval:     config.reconnectionMaxDelay,
			}
		default:
			return fmt.Errorf("unsupported Cassandra reconnection policy: %s", config.reconnectionPolicy)
		}
	}
	return nil
}

func applyLoadBalancingPolicy(cluster *gocql.ClusterConfig, config cassandraConfig) error {
	policy := config.loadBalancingPolicy
	if policy == "" {
		policy = "default"
	}
	switch policy {
	case "default":
		if config.localDatacenter == "" {
			return nil
		}
		cluster.PoolConfig.HostSelectionPolicy = gocql.TokenAwareHostPolicy(
			gocql.DCAwareRoundRobinPolicy(config.localDatacenter),
		)
	case "round_robin":
		cluster.PoolConfig.HostSelectionPolicy = gocql.RoundRobinHostPolicy()
	case "dc_aware":
		if config.localDatacenter == "" {
			return fmt.Errorf("DCAwareRoundRobinPolicy requires localdatacenter")
		}
		cluster.PoolConfig.HostSelectionPolicy = gocql.DCAwareRoundRobinPolicy(config.localDatacenter)
	case "token_aware":
		fallback := gocql.RoundRobinHostPolicy()
		if config.localDatacenter != "" {
			fallback = gocql.DCAwareRoundRobinPolicy(config.localDatacenter)
		}
		cluster.PoolConfig.HostSelectionPolicy = gocql.TokenAwareHostPolicy(fallback)
	default:
		return fmt.Errorf("unsupported Cassandra loadbalancing policy: %s", policy)
	}
	return nil
}

func normalizeOptionName(value string) string {
	return strings.NewReplacer("_", "", "-", "", ".", "").Replace(strings.ToLower(strings.TrimSpace(value)))
}

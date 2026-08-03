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
	disableInitialHostLookup bool
}

func parseCassandraConfig(cp connectParams) (cassandraConfig, error) {
	config := cassandraConfig{
		port:           9042,
		keyspace:       strings.TrimSpace(cp.Database),
		username:       cp.Username,
		password:       cp.Password,
		requestTimeout: 11 * time.Second,
		connectTimeout: defaultConnectTimeout,
		numConnections: 2,
		pageSize:       5000,
		ssl:            cp.SSL,
		caCertPath:     cp.CACertPath,
		clientCertPath: cp.ClientCertPath,
		clientKeyPath:  cp.ClientKeyPath,
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
	config.hosts = splitHosts(parsed.Hostname())
	if strings.Contains(parsed.Host, ",") {
		hostPart := parsed.Host
		if parsed.User != nil {
			hostPart = strings.TrimPrefix(hostPart, parsed.User.String()+"@")
		}
		config.hosts = splitHosts(hostPart)
	}
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
		case "ssl":
			enabled, err := strconv.ParseBool(value)
			if err != nil {
				return fmt.Errorf("invalid ssl option: %w", err)
			}
			config.ssl = enabled
		case "hostverification", "verifyhostname", "sslhostnameverification":
			enabled, err := strconv.ParseBool(value)
			if err != nil {
				return fmt.Errorf("invalid host verification option: %w", err)
			}
			config.hostVerification = enabled
		case "disableinitialhostlookup":
			disabled, err := strconv.ParseBool(value)
			if err != nil {
				return fmt.Errorf("invalid disableinitialhostlookup option: %w", err)
			}
			config.disableInitialHostLookup = disabled
		case "loadbalancing":
			if value != "" && !strings.EqualFold(value, "DcInferringLoadBalancingPolicy") {
				return fmt.Errorf("unsupported Cassandra loadbalancing policy: %s", value)
			}
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
	if config.localDatacenter != "" {
		cluster.PoolConfig.HostSelectionPolicy = gocql.TokenAwareHostPolicy(
			gocql.DCAwareRoundRobinPolicy(config.localDatacenter),
		)
	}
	return cluster, nil
}

func splitHosts(raw string) []string {
	parts := strings.FieldsFunc(raw, func(char rune) bool { return char == ',' || char == ';' })
	hosts := make([]string, 0, len(parts))
	for _, part := range parts {
		host := strings.TrimSpace(part)
		if host == "" {
			continue
		}
		if parsedHost, _, err := net.SplitHostPort(host); err == nil {
			host = parsedHost
		}
		hosts = append(hosts, strings.Trim(host, "[]"))
	}
	return hosts
}

func allLoopbackHosts(hosts []string) bool {
	for _, host := range hosts {
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

func normalizeOptionName(value string) string {
	return strings.NewReplacer("_", "", "-", "", ".", "").Replace(strings.ToLower(strings.TrimSpace(value)))
}

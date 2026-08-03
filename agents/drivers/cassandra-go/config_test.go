package main

import (
	"testing"
	"time"
)

func TestParseCassandraConfigSupportsLegacyJDBCOptions(t *testing.T) {
	config, err := parseCassandraConfig(connectParams{
		Host:      "127.0.0.1",
		Database:  "app",
		Username:  "cassandra",
		Password:  "secret",
		URLParams: "?localdatacenter=dc1&requesttimeout=10000&connecttimeout=5s&protocolversion=4&consistency=local_quorum&numconns=4",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(config.hosts) != 1 || config.hosts[0] != "127.0.0.1" {
		t.Fatalf("unexpected hosts: %#v", config.hosts)
	}
	if config.port != 9042 || config.keyspace != "app" {
		t.Fatalf("unexpected endpoint: port=%d keyspace=%q", config.port, config.keyspace)
	}
	if config.localDatacenter != "dc1" || config.protocolVersion != 4 {
		t.Fatalf("unexpected topology config: %#v", config)
	}
	if config.requestTimeout != 10*time.Second || config.connectTimeout != 5*time.Second {
		t.Fatalf("unexpected timeouts: request=%s connect=%s", config.requestTimeout, config.connectTimeout)
	}
	if config.numConnections != 4 || !config.disableInitialHostLookup {
		t.Fatalf("unexpected pool/tunnel config: %#v", config)
	}
}

func TestParseCassandraConfigAcceptsConnectionString(t *testing.T) {
	config, err := parseCassandraConfig(connectParams{
		ConnectionString: "jdbc:cassandra://alice:secret@db.example.com:9142/catalog?protocolversion=5",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(config.hosts) != 1 || config.hosts[0] != "db.example.com" || config.port != 9142 {
		t.Fatalf("unexpected endpoint: %#v", config)
	}
	if config.keyspace != "catalog" || config.username != "alice" || config.password != "secret" {
		t.Fatalf("unexpected credentials/keyspace: %#v", config)
	}
	if config.protocolVersion != 5 {
		t.Fatalf("unexpected protocol version: %d", config.protocolVersion)
	}
}

func TestParseCassandraConfigRejectsUnsupportedLoadBalancingClass(t *testing.T) {
	_, err := parseCassandraConfig(connectParams{
		Host:      "localhost",
		URLParams: "loadbalancing=example.CustomPolicy",
	})
	if err == nil {
		t.Fatal("expected unsupported load-balancing policy error")
	}
}

func TestParseCassandraConfigRejectsCassandra20Protocol(t *testing.T) {
	_, err := parseCassandraConfig(connectParams{
		Host:      "localhost",
		URLParams: "protocolversion=2",
	})
	if err == nil {
		t.Fatal("expected native protocol v2 rejection")
	}
}

func TestParseDurationOptionTreatsBareNumbersAsMilliseconds(t *testing.T) {
	duration, err := parseDurationOption("1500")
	if err != nil {
		t.Fatal(err)
	}
	if duration != 1500*time.Millisecond {
		t.Fatalf("unexpected duration: %s", duration)
	}
}

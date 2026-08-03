# Cassandra native Agent

The Cassandra Agent uses Apache `cassandra-gocql-driver` and implements the DBX
multi-session JSON-RPC protocol without a JVM.

## Compatibility

- Native protocol versions: v3-v5
- Declared server range: Apache Cassandra 2.1+
- Live validation: 2.2.19, 3.11.19, 4.1.10, and 5.0.6
- Authentication: username/password
- TLS: CA verification, optional client certificate/key, hostname verification
- Metadata: keyspaces, tables, columns, indexes, CQL table DDL, completion search
- Queries: legacy string result values, paging, cancellation, logged and unlogged batches

The Agent accepts both normal DBX connection fields and Cassandra JDBC-style
connection strings, including the wrapper's `host1--host2:9042` contact-point
syntax.

## JDBC URL parameter mapping

| JDBC parameter | Native behavior |
| --- | --- |
| `consistency` | GoCQL consistency |
| `fetchsize` | default page size |
| `retries` | retry/reconnection attempt count |
| `loadbalancing` | default, round-robin, DC-aware, or token-aware built-in policy |
| `localdatacenter` | DC-aware host selection |
| `retry` | default/simple, fallthrough, downgrading, or exponential built-in policy |
| `reconnection` | constant or exponential reconnection policy |
| `debug` | GoCQL debug logging to stderr |
| `enablessl` | TLS enablement |
| `sslenginefactory` | the standard `DefaultSslEngineFactory` maps to native TLS |
| `hostnameverification` | TLS hostname verification; enabled by default |
| `user`, `password` | password authentication |
| `requesttimeout`, `connecttimeout` | request and connection deadlines |
| `tcpnodelay`, `keepalive` | native TCP socket options |
| `compliancemode` | accepted; JDBC-only `java.sql` behavior is not applicable to JSON-RPC |

Java implementation hooks do not have a safe native equivalent. The Agent
returns a targeted connection error for `configfile`, `usekrb5=true`,
`secureconnectbundle`, custom `sslenginefactory` classes, and custom policy
classes. Translate Java HOCON settings to the supported URL parameters before
migrating a connection.

## Integration test

```bash
CASSANDRA_TEST_HOST=127.0.0.1 \
CASSANDRA_TEST_PORT=9042 \
CASSANDRA_TEST_USERNAME=cassandra \
CASSANDRA_TEST_PASSWORD=cassandra \
go test -run TestCassandraIntegration -v
```

Optional variables include `CASSANDRA_TEST_URL_PARAMS`, `CASSANDRA_TEST_SSL`,
`CASSANDRA_TEST_CA_CERT_PATH`, `CASSANDRA_TEST_CLIENT_CERT_PATH`, and
`CASSANDRA_TEST_CLIENT_KEY_PATH`.

See `bench/README.md` for the archived JDBC comparison workflow and measured
Cassandra 4.1.10 results.

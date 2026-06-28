# Gap Analysis & Fixes Applied

This document records the issues found during the v4 audit and the fixes applied.

| # | Gap Found | Severity | Fix Applied |
|---|-----------|----------|-------------|
| 1 | Write results published to pub/sub channel `opcua:write:results` but API polled key `opcua:write:result:{id}` — writes always timed out | Critical | Write engine now `SETEX`-stores result as retrievable key (60s TTL) AND publishes to channel |
| 2 | API sent `browse` command via Redis but registry had no browse handler | Critical | Added `browse`, `read`, `restart`, `server_info` handlers to registry command listener |
| 3 | API `opcua_mgmt.py` opened its own OPC UA connection, competing with the client (session/cert conflicts under SignAndEncrypt) | High | Refactored all mgmt operations to route THROUGH the client via Redis; only endpoint-discovery uses a transient pre-subscription channel |
| 4 | API settings missing replica DSN, redis_url, feature flags | Medium | Added all fields + `pg_replica_dsn_sync` property |
| 5 | Emergency-stop command published but not routed in client method listener | Critical | Added `emergency_stop` branch to `_method_listener` in main.py |
| 6 | Write/method results not stored as retrievable keys | Critical | Both engines now `SETEX` result keys |
| 7 | docker-compose.yml did not pass FEATURE_* flags to containers | High | Added all feature flags to both `opcua-client` and `api` services |
| 8 | Frontend double `/api/api/...` path bug (axios baseURL already had `/api`) | Critical | Fixed all paths in WriteControlPage, MethodCallPage, useFeatures |
| 9 | Registry browse/read not exposed via command channel | High | Wired into command listener (see #2) |
| 14 | `read_node` returned raw OPC ua.Variant values (not JSON-serializable) | Medium | Coerce to JSON-safe types before returning |
| 15 | `create_template` called `get_redis()` directly instead of DI | Low | Use `Depends(get_redis)` |
| 17 | `restart` command published but ignored by registry | Medium | Added restart handler (disconnects → auto-reconnect) |
| 20 | Frontend called `/opcua/server-info` and `/opcua/endpoints` that were removed in refactor | Critical | Re-added both, routed through client (server-info) and transient discovery (endpoints) |

## Verification

- All 50 Python files compile cleanly (`py_compile`)
- Both docker-compose files are valid YAML
- Feature flags wired end-to-end: .env → compose → client/api main.py
- All 8 frontend OPC UA endpoints match backend routes
- All dependencies present in requirements.txt (including httpx, aiokafka)

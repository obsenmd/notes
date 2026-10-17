# Obsen contracts

`obsen/v1/obsen.proto` defines the unary account and publishing services.
The Twirp adapter supports binary protobuf and standard ProtoJSON on the same
method URLs. It dispatches through existing server handlers; legacy HTTP inputs
and WebSocket sync are preserved.

`obsen/v1/admin.proto` defines all 20 administrative operations, typed inputs,
typed results, structured errors, and the local IPC envelopes. `Administration`
documents the methods; it is not registered as an HTTP/Twirp service. Local clients
send the versioned preface and bounded protobuf frames documented in that file.
The CLI uses this contract, while the server also accepts legacy JSON lines.

Edit these files when changing an RPC contract. Do not reuse field numbers.
Reserve removed field numbers/names; introduce a new versioned package for
breaking changes. Update the shared DTO/endpoint registry and run
`cargo test -p obsen-rpc -p obsen-client` to check coverage and both encodings.
Run `cargo test -p obsen-cli` for real protobuf IPC command and pagination tests,
and `cargo test -p obsen-server ipc::tests` for IPC authentication/framing checks.
Generated Rust types and descriptors live in Cargo's build output, not in source.

Dynamic publishing options and inventories use protobuf `Value`/`Struct`.
Page and file content use `BodyResponse` to preserve bytes, application status,
repeated headers, media ranges, redirects and cookies. Sync retains its existing
WebSocket framing and is intentionally absent from the unary services.

# Privacy boundary

The public repository must never contain user-specific Context Capsule data, chats, Recovery Capsules, Private Audit Trace records, credentials, API keys, tokens, or exported files.

By default, the PWA stores working state in browser IndexedDB on the current device. A Recovery Capsule is created only when the user explicitly exports it. The capsule excludes Private Audit Trace internals.

`localOnly` is enabled by default. The current v0.7.1 build has no OpenAI API integration, no email bridge, and no GitHub bot transport.

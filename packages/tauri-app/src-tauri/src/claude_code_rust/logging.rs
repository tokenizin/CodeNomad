use tracing_subscriber::{
    EnvFilter,
    fmt::{self, time::SystemTime},
    layer::SubscriberExt,
    Layer,
};

/// Initialise structured JSON logging to stderr.
///
/// Reads `RUST_LOG` for the filter directive; falls back to `info` if unset.
///
/// The JSON formatter emits at least:
///   - `timestamp`
///   - `level`
///   - `target`
///   - `message`
///   - `span` (active spans and their fields)
///
/// Downstream code can attach extra fields that surface in the same JSON
/// object when they are present on the current span or event, e.g.:
///
/// ```ignore
/// #[instrument(fields(session_id = tracing::field::Empty))]
/// pub fn handle(session_id: &str) {
///     tracing::Span::current().record("session_id", session_id);
///     // ...
/// }
/// ```
///
/// Spans closed by `#[instrument]` also emit their `duration_ms` as a
/// span field in the trailing `"spans"` array.
pub fn init() {
    // Prefer explicit crate-scope defaults; let RUST_LOG override at runtime.
    let filter = EnvFilter::from_default_env()
        .add_directive("bridge=info".parse().expect("invalid default filter directive"));

    let fmt = fmt::layer()
        .json()
        .with_timer(SystemTime)
        .with_target(true)
        .with_level(true)
        .with_thread_ids(false)
        .with_file(false)
        .with_line_number(false)
        .boxed();

    let subscriber = tracing_subscriber::Registry::default()
        .with(filter)
        .with(fmt);

    tracing::subscriber::set_global_default(subscriber)
        .expect("failed to set global tracing subscriber");
}

//! Unit tests for persistent error logging and log rotation (app_log.rs).

use super::*;

#[test]
fn log_writes_timestamped_line_and_rotates_above_limit() {
    let dir = tempfile::tempdir().unwrap();
    let logs_dir = dir.path().join("logs");

    // 1. Creates directory and writes a timestamped line.
    write_to_dir(&logs_dir, "Test context", &"boom");
    let log_path = logs_dir.join("app.log");
    let content = fs::read_to_string(&log_path).unwrap();
    assert!(content.contains(" | Test context: boom"), "unexpected log line: {content}");
    assert!(!logs_dir.join("app.log.old").exists());

    // 2. Exceeding 512 KiB rotates app.log -> app.log.old and starts a fresh app.log.
    fs::write(&log_path, vec![b'x'; (MAX_LOG_BYTES as usize) + 1]).unwrap();
    write_to_dir(&logs_dir, "After rotation", &"second");
    let rotated = logs_dir.join("app.log.old");
    assert!(rotated.is_file());
    assert_eq!(fs::metadata(&rotated).unwrap().len(), MAX_LOG_BYTES + 1);
    let fresh = fs::read_to_string(&log_path).unwrap();
    assert!(fresh.contains(" | After rotation: second"), "unexpected fresh log: {fresh}");
    assert!(fresh.len() < 128);
}

//! `tmux -C` control mode source.
//!
//! Spawns `tmux -C attach -t <session>` (or default session), parses
//! line-oriented notifications and emits SourceEvents. The interesting part is
//! the octal-unescape for `%output` payloads.
//!
//! Tmux control protocol reference: see man tmux(1) section CONTROL MODE.

use super::{PaneId, SourceEvent};
use anyhow::{Context, Result};
use bytes::Bytes;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tracing::{debug, warn};

pub struct TmuxControl {
    child: Child,
}

#[derive(Default, Debug, Clone)]
pub struct SpawnOpts {
    pub socket_name: Option<String>,
    pub target_session: Option<String>,
}

impl TmuxControl {
    /// Start `tmux -C attach` against an existing tmux server.
    pub fn spawn(target_session: Option<&str>) -> Result<(Self, mpsc::Receiver<SourceEvent>)> {
        Self::spawn_with(SpawnOpts {
            target_session: target_session.map(String::from),
            ..Default::default()
        })
    }

    pub fn spawn_with(opts: SpawnOpts) -> Result<(Self, mpsc::Receiver<SourceEvent>)> {
        let mut cmd = Command::new("tmux");
        if let Some(sock) = &opts.socket_name {
            cmd.arg("-L").arg(sock);
        }
        cmd.arg("-C").arg("attach");
        if let Some(s) = &opts.target_session {
            // -r marks the attach as read-only so this observer can never
            // accidentally affect the user's session. Pane input still works
            // because `Input` commands shell out to `tmux send-keys` directly,
            // not through this control client.
            cmd.arg("-r").arg("-t").arg(s);
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // Without kill_on_drop the tmux client lingers until tmux is
            // restarted; with it we cleanly detach when MultiSession drops a
            // ChildHandle for a session that's gone.
            .kill_on_drop(true);
        let mut child = cmd.spawn().context("spawning tmux -C")?;

        let stdout = child.stdout.take().context("tmux stdout missing")?;
        let stderr = child.stderr.take().context("tmux stderr missing")?;

        let (tx, rx) = mpsc::channel(1024);

        // stderr just gets logged.
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                warn!(target: "tmux", "stderr: {line}");
            }
        });

        // stdout drives the event stream.
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            let mut in_command_response = false;
            loop {
                let line = match reader.next_line().await {
                    Ok(Some(l)) => l,
                    Ok(None) => {
                        let _ = tx
                            .send(SourceEvent::Closed {
                                reason: "tmux stdout EOF".into(),
                            })
                            .await;
                        break;
                    }
                    Err(e) => {
                        let _ = tx
                            .send(SourceEvent::Closed {
                                reason: format!("tmux read error: {e}"),
                            })
                            .await;
                        break;
                    }
                };
                for ev in parse_line(&line, &mut in_command_response) {
                    if tx.send(ev).await.is_err() {
                        return;
                    }
                }
            }
        });

        Ok((TmuxControl { child }, rx))
    }

    pub async fn kill(mut self) -> Result<()> {
        self.child.kill().await?;
        Ok(())
    }
}

/// Parse a single line of tmux control-mode output. Most lines map to one
/// event; `%layout-change` can fan out into N `Resized` events (one per
/// leaf pane in the new layout), so the return type is a Vec.
///
/// Lines we care about:
///   `%output %<pane_id> <octal-escaped bytes>`
///   `%window-add @<window_id>`
///   `%window-close @<window_id>`
///   `%layout-change @<window> <visible-layout> <whole-layout> <flags>`
///   `%exit [reason]`
///
/// Lines we skip:
///   command response framing (`%begin ... %end`/`%error`)
///   any `%subscription-changed`, `%continue`, `%session-changed`, etc.
fn parse_line(line: &str, in_command_response: &mut bool) -> Vec<SourceEvent> {
    if line.starts_with("%begin ") {
        *in_command_response = true;
        return Vec::new();
    }
    if line.starts_with("%end ") || line.starts_with("%error ") {
        *in_command_response = false;
        return Vec::new();
    }
    if *in_command_response {
        // Command response payload — ignore for now (no commands sent yet).
        return Vec::new();
    }

    // Notifications.
    if let Some(rest) = line.strip_prefix("%output ") {
        // %output %<pane> <data>
        let Some((pane_token, data)) = rest.split_once(' ') else {
            return Vec::new();
        };
        let Some(pane) = pane_token.strip_prefix('%') else {
            return Vec::new();
        };
        let bytes = unescape_tmux_output(data);
        return vec![SourceEvent::Output {
            pane: PaneId(format!("%{pane}")),
            bytes: Bytes::from(bytes),
        }];
    }
    if let Some(rest) = line.strip_prefix("%window-add ") {
        return vec![SourceEvent::PaneAdded {
            pane: PaneId(rest.to_string()),
            session: None,
            window: None,
        }];
    }
    if let Some(rest) = line.strip_prefix("%window-close ") {
        return vec![SourceEvent::PaneClosed {
            pane: PaneId(rest.to_string()),
        }];
    }
    if let Some(rest) = line.strip_prefix("%layout-change ") {
        // `%layout-change @<window> <visible-layout> <whole-layout> <flags>`
        // The visible-layout is the second token. Walk it, emit Resized
        // for every leaf pane.
        let mut tokens = rest.split_whitespace();
        let window = tokens.next().unwrap_or("?");
        if let Some(layout) = tokens.next() {
            let panes = parse_layout_panes(layout);
            // Diag: log every parsed layout-change so "did panel see this
            // resize?" is grep-able from journalctl. The summary form keeps
            // log volume manageable when many resizes happen quickly.
            tracing::info!(
                target: "tmux_layout",
                "layout-change window={window} panes={panes:?}"
            );
            let mut events = Vec::new();
            for (pane_id, cols, rows) in panes {
                events.push(SourceEvent::Resized {
                    pane: PaneId(pane_id),
                    rows,
                    cols,
                });
            }
            return events;
        }
        return Vec::new();
    }
    if let Some(rest) = line.strip_prefix("%exit") {
        return vec![SourceEvent::Closed {
            reason: rest.trim().to_string(),
        }];
    }
    debug!(target: "tmux", "unhandled notification: {line}");
    Vec::new()
}

/// Walk a tmux layout string and return `(pane_id, cols, rows)` for every
/// leaf pane. tmux's layout grammar:
///
///   node      = csum "," WxH "," X "," Y ( "," PANE_ID | "{" nodes "}" | "[" nodes "]" )
///   nodes     = node ( "," node )*
///   csum      = 4 hex chars
///   PANE_ID   = decimal pane index (no leading `%`)
///
/// Examples:
///   `ea6e,100x30,0,0,264`
///       → vec![("%264", 100, 30)]
///   `abcd,100x60,0,0[ab12,100x30,0,0,1,cd34,100x29,0,31,2]`
///       → vec![("%1", 100, 30), ("%2", 100, 29)]
///
/// Implementation: scan for every `,WxH,X,Y` pattern; if it's followed
/// directly by `,paneId` (and that pane id is followed by `,`/`}`/`]`/EOL)
/// it's a leaf and we record it. Splits (`{` / `[`) just skip; the inner
/// nodes get picked up by the same scan as we keep walking.
pub fn parse_layout_panes(layout: &str) -> Vec<(String, u16, u16)> {
    let bytes = layout.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b',' {
            i += 1;
            continue;
        }
        let mut p = i + 1;
        // Parse W
        let w_start = p;
        while p < bytes.len() && bytes[p].is_ascii_digit() {
            p += 1;
        }
        if p == w_start || p >= bytes.len() || bytes[p] != b'x' {
            i += 1;
            continue;
        }
        let w: u16 = match std::str::from_utf8(&bytes[w_start..p])
            .ok()
            .and_then(|s| s.parse().ok())
        {
            Some(v) => v,
            None => {
                i += 1;
                continue;
            }
        };
        p += 1; // skip 'x'
        let h_start = p;
        while p < bytes.len() && bytes[p].is_ascii_digit() {
            p += 1;
        }
        let h: u16 = match std::str::from_utf8(&bytes[h_start..p])
            .ok()
            .and_then(|s| s.parse().ok())
        {
            Some(v) => v,
            None => {
                i += 1;
                continue;
            }
        };
        // Expect ",X,Y"
        if p >= bytes.len() || bytes[p] != b',' {
            i += 1;
            continue;
        }
        p += 1;
        while p < bytes.len() && bytes[p].is_ascii_digit() {
            p += 1;
        }
        if p >= bytes.len() || bytes[p] != b',' {
            i += 1;
            continue;
        }
        p += 1;
        while p < bytes.len() && bytes[p].is_ascii_digit() {
            p += 1;
        }
        // Now: ',' (leaf), '{' or '[' (split), or end (root single-pane).
        if p >= bytes.len() {
            // No pane id — bail.
            break;
        }
        match bytes[p] {
            b',' => {
                // Leaf: pane id follows.
                let pid_start = p + 1;
                let mut q = pid_start;
                while q < bytes.len() && bytes[q].is_ascii_digit() {
                    q += 1;
                }
                if q > pid_start {
                    if let Ok(pid_str) = std::str::from_utf8(&bytes[pid_start..q]) {
                        out.push((format!("%{pid_str}"), w, h));
                    }
                }
                i = q;
            }
            b'{' | b'[' => {
                // Split — recurse via the outer scan.
                i = p + 1;
            }
            _ => {
                i += 1;
            }
        }
    }
    out
}

/// Unescape the body of a `%output` payload.
///
/// tmux encodes:
///   `\` → `\\`
///   bytes < 0x20 or > 0x7e → `\nnn` (3-digit octal)
pub fn unescape_tmux_output(s: &str) -> Vec<u8> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if c == b'\\' && i + 1 < bytes.len() {
            let next = bytes[i + 1];
            if next == b'\\' {
                out.push(b'\\');
                i += 2;
                continue;
            }
            // Try 3-digit octal (tmux always uses 3 digits in this context).
            if i + 3 < bytes.len() {
                let d1 = bytes[i + 1];
                let d2 = bytes[i + 2];
                let d3 = bytes[i + 3];
                if (b'0'..=b'7').contains(&d1)
                    && (b'0'..=b'7').contains(&d2)
                    && (b'0'..=b'7').contains(&d3)
                {
                    let n =
                        ((d1 - b'0') as u32) * 64 + ((d2 - b'0') as u32) * 8 + (d3 - b'0') as u32;
                    out.push(n as u8);
                    i += 4;
                    continue;
                }
            }
            // Unrecognized — pass the backslash through.
            out.push(c);
            i += 1;
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unescape_plain() {
        assert_eq!(unescape_tmux_output("hello"), b"hello");
    }

    #[test]
    fn unescape_backslash() {
        assert_eq!(unescape_tmux_output(r"a\\b"), b"a\\b");
    }

    #[test]
    fn unescape_octal() {
        // \033 = ESC, \012 = LF, \015 = CR, \007 = BEL
        assert_eq!(
            unescape_tmux_output(r"\033[1mX\033[m"),
            b"\x1b[1mX\x1b[m"
        );
        assert_eq!(unescape_tmux_output(r"a\012b"), b"a\nb");
        assert_eq!(unescape_tmux_output(r"\007"), b"\x07");
    }

    #[test]
    fn unescape_mixed() {
        assert_eq!(
            unescape_tmux_output(r"prompt$ \033[31mred\033[m\012"),
            b"prompt$ \x1b[31mred\x1b[m\n"
        );
    }

    #[test]
    fn parse_output_line() {
        let mut in_cmd = false;
        let evs = parse_line(r"%output %5 hello\012", &mut in_cmd);
        assert_eq!(evs.len(), 1);
        match &evs[0] {
            SourceEvent::Output { pane, bytes } => {
                assert_eq!(pane.0, "%5");
                assert_eq!(&bytes[..], b"hello\n");
            }
            other => panic!("expected Output, got {other:?}"),
        }
    }

    #[test]
    fn parse_window_add() {
        let mut in_cmd = false;
        let evs = parse_line(r"%window-add @42", &mut in_cmd);
        assert_eq!(evs.len(), 1);
        match &evs[0] {
            SourceEvent::PaneAdded { pane, .. } => assert_eq!(pane.0, "@42"),
            other => panic!("expected PaneAdded, got {other:?}"),
        }
    }

    #[test]
    fn parse_command_response_ignored() {
        let mut in_cmd = false;
        assert!(parse_line("%begin 12345 1 0", &mut in_cmd).is_empty());
        assert!(in_cmd);
        assert!(parse_line("some output line", &mut in_cmd).is_empty());
        assert!(parse_line("%end 12345 1 0", &mut in_cmd).is_empty());
        assert!(!in_cmd);
        // After %end, real notifications resume.
        let evs = parse_line(r"%output %1 hi", &mut in_cmd);
        assert_eq!(evs.len(), 1);
    }

    #[test]
    fn parse_layout_single_pane() {
        let panes = parse_layout_panes("ea6e,100x30,0,0,264");
        assert_eq!(panes, vec![("%264".to_string(), 100, 30)]);
    }

    #[test]
    fn parse_layout_horizontal_split() {
        // Two panes side-by-side: pane 1 left (50w), pane 2 right (49w).
        let panes = parse_layout_panes(
            "ef01,100x60,0,0{xy23,50x60,0,0,1,wz34,49x60,51,0,2}",
        );
        assert_eq!(
            panes,
            vec![("%1".into(), 50, 60), ("%2".into(), 49, 60)]
        );
    }

    #[test]
    fn parse_layout_vertical_split() {
        let panes = parse_layout_panes(
            "abcd,100x60,0,0[ab12,100x30,0,0,1,cd34,100x29,0,31,2]",
        );
        assert_eq!(
            panes,
            vec![("%1".into(), 100, 30), ("%2".into(), 100, 29)]
        );
    }

    #[test]
    fn parse_layout_change_emits_resized_per_leaf() {
        let mut in_cmd = false;
        let evs = parse_line(
            "%layout-change @264 ea6e,100x30,0,0,264 ea6e,100x30,0,0,264 *",
            &mut in_cmd,
        );
        assert_eq!(evs.len(), 1);
        match &evs[0] {
            SourceEvent::Resized { pane, rows, cols } => {
                assert_eq!(pane.0, "%264");
                assert_eq!(*cols, 100);
                assert_eq!(*rows, 30);
            }
            other => panic!("expected Resized, got {other:?}"),
        }
    }
}

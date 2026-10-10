//! One module per wire format.

pub mod anthropic;
pub mod openai;

#[cfg(test)]
pub(crate) mod test_util {
    use crate::provider::Decoder;
    use crate::sse::SseParser;
    use crate::ChatEvent;

    /// Run a recorded SSE body through a decoder, the same way the live stream does.
    pub fn decode_all<D: Decoder>(mut decoder: D, body: &str) -> Vec<ChatEvent> {
        let mut parser = SseParser::new();
        let mut events: Vec<_> = parser.push(body.as_bytes());
        events.extend(parser.finish());
        let mut out = vec![];
        for ev in events {
            out.extend(decoder.on_event(ev).expect("decode"));
            if decoder.is_done() {
                break;
            }
        }
        out.extend(decoder.finish());
        out
    }

    /// Concatenate all text deltas.
    pub fn text(events: &[ChatEvent]) -> String {
        events
            .iter()
            .filter_map(|e| match e {
                ChatEvent::TextDelta { delta } => Some(delta.as_str()),
                _ => None,
            })
            .collect()
    }
}

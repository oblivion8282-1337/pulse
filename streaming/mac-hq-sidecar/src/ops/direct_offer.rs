//! `direct_offer` — das Angebot des Players annehmen und beantworten.
//!
//! ```jsonc
//! {"op":"direct_offer","id":N,"params":{"sdp":"<Angebots-SDP>"}}
//! → {"id":N,"ok":true,"type":"answer","sdp":"<Answer-SDP>"}
//! ```
//!
//! Die eigentliche Arbeit liegt in [`crate::direct::Sitzung::anbieten`]
//! (Aushandlung, Gathering, srflx-Fallback); dieser Handler ist nur die
//! Wire-Form. Ein zweites Angebot ohne dazwischenliegendes `direct_stop`
//! scheitert mit dem vertraglichen Text `direct session already negotiated`
//! — die Buchung dafür steht in `crate::direct::ablauf`.

use anyhow::{anyhow, Result};
use serde_json::{Map, Value};

use crate::direct::sitzung;

pub fn handle(params: Map<String, Value>) -> Result<Map<String, Value>> {
    let offer = params
        .get("sdp")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("direct_offer braucht params.sdp (das Angebots-SDP)"))?;
    let answer = sitzung().anbieten(offer)?;
    let mut out = Map::new();
    out.insert("type".to_string(), Value::String("answer".to_string()));
    out.insert("sdp".to_string(), Value::String(answer));
    Ok(out)
}

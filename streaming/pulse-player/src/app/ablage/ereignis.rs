//! Der Ereignisrahmen, mit dem ein Ablage-Rahmen den Player verlaesst.
//!
//! **Das Einzige, was von `app/ablage/lage.rs` hier zurueckblieb**, als die
//! Zustandsfuehrung am 2026-08-31 nach `pulse_ablage::lage` zog: sie ist auf
//! beiden Haelften dieselbe, dieses Ereignisformat nicht — es gehoert dem
//! stdio-Protokoll des Players (`crate::proto::Event`), und der Windows-Sidecar
//! hat sein eigenes (`crate::events::emit`).

use pulse_ablage::format::Rahmen;

use crate::proto::Event;

/// Der Ereignisrahmen hinaus. Wie `eingabe_ereignis` in `app/eingabe.rs`
/// gebaut, nur mit `"ablage"` und `data`.
pub(super) fn ablage_ereignis(id: u64, r: &Rahmen) -> Event {
    Event::new("ablage", serde_json::json!({ "session": id, "data": r.nach_json() }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use pulse_ablage::format::Inhaltstyp;

    #[test]
    fn ein_hinausgehender_rahmen_traegt_die_sitzung() {
        let ev = ablage_ereignis(7, &Rahmen::Neu { generation: 1, typ: Inhaltstyp::Text });
        let v = serde_json::to_value(&ev).expect("serialisierbar");
        assert_eq!(v["ev"], "ablage");
        assert_eq!(v["session"], 7);
        assert_eq!(v["data"]["t"], "neu");
        // **Die Sitzung reist mit, obwohl der Renderer sie heute nicht liest**
        // (`aufAblageEreignisse` reicht nur `data` weiter): die Zwischenablage
        // gehoert der Maschine, nicht dem Fenster. Sie steht hier fuer die
        // Diagnose und fuer den Tag, an dem zwei Gegenstellen zugleich moeglich
        // sind — dann muss der Rueckweg sie auswerten.
        assert!(v["session"].is_number());
    }
}

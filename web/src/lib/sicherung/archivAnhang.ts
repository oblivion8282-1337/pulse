/**
 * Der Bedarfs-Weg der Sicherung: die Klartext-Bytes EINES Anhangs aus dem
 * Archiv holen — genau dann, wenn eine Chat-Kachel ihn rendert, statt beim
 * ersten Login das ganze Bildarchiv herunterzuladen (Hebel 1). Liefert
 * null, wenn dieses Gerät die Sicherung nicht geöffnet hat oder der Anhang
 * dort fehlt — der Aufrufer (anhangHolen) fällt dann auf den Serverweg
 * zurück, wie bei einem Gerät ohne Sicherung.
 */

import { entschlüsseleEintrag } from './krypto';
import { adapterLieferant, dekAusZwischenlager, anhangDateiName } from './geraete';

export async function archivAnhangHolen(id: string): Promise<Blob | null> {
	try {
		const entpackt = await dekAusZwischenlager();
		if (!entpackt) return null;
		const adapter = await adapterLieferant();
		const dunkel = await adapter.lese(anhangDateiName(id));
		if (dunkel === null) return null;
		const klar = await entschlüsseleEintrag(entpackt.dek, dunkel);
		return new Blob([klar as unknown as BlobPart]);
	} catch {
		return null;
	}
}

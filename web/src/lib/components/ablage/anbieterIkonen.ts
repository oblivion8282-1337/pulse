/**
 * Icon je Ablage-Anbieter — an einer Stelle, damit der Verbinden-Dialog und
 * die Speicher-Zeile (Einstellungen) dasselbe Symbol zeigen.
 *
 * Steht bewusst NICHT in `lib/ablage/anbieter.ts`: die dortige Liste ist
 * importfrei (Node-Testläufer prüft sie ohne Bundler, s. CLAUDE.md zur
 * `pnpm test:unit`-Falle), und Icons sind reine Oberflächen-Sache, die dort
 * nichts zu suchen hat.
 */

import PackageIcon from '@lucide/svelte/icons/package';
import CloudIcon from '@lucide/svelte/icons/cloud';
import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
import GlobeIcon from '@lucide/svelte/icons/globe';
import FolderIcon from '@lucide/svelte/icons/folder';
import DatabaseIcon from '@lucide/svelte/icons/database';
import type { AblageAnbieterArt } from '$lib/ablage/anbieter.ts';

export const ANBIETER_IKONE: Record<AblageAnbieterArt, typeof PackageIcon> = {
	dropbox: PackageIcon,
	onedrive: CloudIcon,
	gdrive: HardDriveIcon,
	nextcloud: GlobeIcon,
	sync_ordner: FolderIcon,
	s3: DatabaseIcon,
};

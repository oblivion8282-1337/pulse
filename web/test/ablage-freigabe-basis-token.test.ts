import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tokenAusWebdavBasis } from '../src/lib/ablage/freigabeBasisToken.ts';

test('zieht das Token aus einer gewoehnlichen Nextcloud-Freigabe-Basis', () => {
	assert.equal(
		tokenAusWebdavBasis('https://cloud.example/public.php/dav/files/AbCdEf12'),
		'AbCdEf12'
	);
});

test('funktioniert auch bei einer Nextcloud in einem Unterverzeichnis', () => {
	assert.equal(
		tokenAusWebdavBasis('https://cloud.example/nextcloud/public.php/dav/files/AbCdEf12'),
		'AbCdEf12'
	);
});

test('ignoriert einen Schraegstrich am Ende', () => {
	assert.equal(
		tokenAusWebdavBasis('https://cloud.example/public.php/dav/files/AbCdEf12/'),
		'AbCdEf12'
	);
});

test('eine leere Basis liefert einen leeren Token statt zu werfen', () => {
	assert.equal(tokenAusWebdavBasis(''), '');
});

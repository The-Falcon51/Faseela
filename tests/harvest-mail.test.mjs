import { test } from 'node:test';
import assert from 'node:assert/strict';

// templates.ts reads Deno.env at load time; a stub is enough for the pure render function.
globalThis.Deno = globalThis.Deno || { env: { get: () => undefined } };
const { render } = await import('../supabase/functions/send-emails/templates.ts');

test('weighed harvest review mails use harvest wording, mill pressings keep the pressing wording', () => {
  const harvest = render('batch_certified', { treeId: 'tree_14', certificateSerial: 'W-1', unit: 'kg' });
  assert.match(harvest.subject, /Weighed harvest approved/);
  assert.match(harvest.en, /Harvest record/);
  assert.doesNotMatch(`${harvest.subject} ${harvest.en} ${harvest.ar}`, /Pressing|العصر|certificate/i);

  const rejected = render('batch_rejected', { treeId: 'tree_14', unit: 'kg', note: 'no' });
  assert.match(rejected.subject, /Weighed harvest not approved/);
  assert.doesNotMatch(`${rejected.subject} ${rejected.en}`, /Pressing/);

  const pressing = render('batch_certified', { treeId: 'tree_01', certificateSerial: 'LAB-1', unit: 'l' });
  assert.match(pressing.subject, /Pressing batch certified/);
  assert.match(render('batch_rejected', { treeId: 'tree_01' }).subject, /Pressing batch not certified/);
});

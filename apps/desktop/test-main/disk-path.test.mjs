import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { asOnDisk } = createRequire(import.meta.url)('../electron/disk-path.cjs');

test(
  'a folder written in another case is spelled as the disk has it',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const directory = await mkdtemp(join(await realpath(tmpdir()), 'cc-desk-disk-path-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const project = join(directory, 'My 项目');
    await mkdir(project);
    assert.equal(await asOnDisk(join(directory, 'my 项目')), project);
    assert.equal(await asOnDisk(`${join(directory, 'MY 项目')}/`), project);
    assert.equal(await asOnDisk(project), project);
    // A path through a link, and one that is not there, stay as written.
    const link = join(directory, 'link');
    await symlink(project, link);
    assert.equal(await asOnDisk(link), link);
    assert.equal(await asOnDisk(join(directory, 'missing')), join(directory, 'missing'));
  },
);

test('other systems leave a path as written', { skip: process.platform === 'darwin' }, async () => {
  assert.equal(await asOnDisk('C:\\Projects\\APP'), 'C:\\Projects\\APP');
  assert.equal(await asOnDisk('/home/Me/app'), '/home/Me/app');
});

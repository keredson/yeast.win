import test from 'node:test';
import assert from 'node:assert/strict';
import { routeFromPath, routePath, workspaceBase } from '../client/appRoutes.ts';

test('dashboard uses the root URL for the default brewery and the brewery base for named breweries', () => {
  const workspaces = [{ id: 'default', name: 'Homebrew', slug: null },
    { id: 'brewery', name: 'Brewery', slug: 'brewery' }];
  assert.equal(routePath('home', null, workspaceBase('default', workspaces)), '/');
  assert.equal(routePath('home', null, workspaceBase('brewery', workspaces)), '/brewery/brewery');
  assert.deepEqual(routeFromPath('/'), { section: 'home', selectedId: null, slug: null });
  assert.deepEqual(routeFromPath('/brewery/brewery'), { section: 'home', selectedId: null, slug: 'brewery' });
  assert.deepEqual(routeFromPath('/brewery/brewery/equipment/fermenter/f-01'),
    { section: 'equipment', selectedId: 'fermenter/f-01', slug: 'brewery' });
});

test('account settings have a standalone URL and old links resolve to it', () => {
  assert.equal(routePath('settings', null, '/brewery/brewery'), '/settings');
  assert.deepEqual(routeFromPath('/settings'), { section: 'settings', selectedId: null, slug: null });
  assert.deepEqual(routeFromPath('/me'), routeFromPath('/settings'));
});

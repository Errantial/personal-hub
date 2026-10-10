import assert from 'node:assert/strict';

// Only the reserved synthetic loopback server; never an owner/provider URL.
const origin = 'http://127.0.0.1:3011';
const login = await fetch(`${origin}/api/v1/auth/login`, {
  method: 'POST',
  headers: { Origin: 'https://localhost', 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: 'android@example.test',
    password: 'synthetic-android-password',
  }),
});
assert.equal(
  login.status,
  200,
  'Synthetic device account must be enrolled first.',
);
const cookie = login.headers.get('set-cookie')?.split(';')[0];
assert.ok(cookie);
const response = await fetch(`${origin}/api/v1/tasks`, {
  headers: { Cookie: cookie },
});
assert.equal(response.status, 200);
const { tasks } = await response.json();
if (process.argv.includes('--empty')) {
  assert.equal(
    tasks.length,
    0,
    'Offline edits must not have reached the server.',
  );
  console.log(
    'Receipt: server has zero tasks while the device outbox is offline.',
  );
} else {
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, 'Android offline proof');
  assert.equal(tasks[0].notes, 'Edited offline, then completed');
  assert.equal(tasks[0].completed, true);
  assert.equal(tasks[0].version, 3);
  console.log(
    'Receipt: one task, version 3, completed; create/edit/completion reconciled once.',
  );
}

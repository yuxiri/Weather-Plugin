import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const start = index.indexOf('async function sendToChat(');
const end = index.indexOf('\nfunction warningTime(', start);
assert.ok(start >= 0 && end > start, 'sendToChat implementation must be present');
const code = index.slice(start, end);
const target = { botId: 'bot-test', type: 'private', targetId: 'target-test' };
function sender(result, calls = []) {
  const send = route => async (...args) => { calls.push({ route, args }); return result; };
  return vm.runInNewContext(`(${code})`, { Bot: {
    sendFriendMsg: send('private'), sendGroupMsg: send('group'),
  } });
}

test('QQBot all-failure result rejects instead of recording delivery success', async () => {
  await assert.rejects(sender({ message_id: [], data: [], error: [new Error('AccessToken expired')] })(target, 'image'), /发送接口没有确认成功/);
});
test('empty QQBot aggregate is not delivery confirmation', async () => {
  await assert.rejects(sender({ message_id: [], data: [], error: [] })(target, 'image'), /发送接口没有确认成功/);
});
test('confirmed partial delivery avoids automatic duplicate sends', async () => {
  await sender({ message_id: ['message-1'], data: [{ id: 'message-1' }], error: [new Error('earlier attempt failed')] })(target, 'image');
});
test('successful QQBot response without a message id stays supported', async () => {
  await sender({ message_id: [], data: [{ accepted: true }], error: [] })(target, 'image');
});
test('message id confirmation alone is supported', async () => {
  await sender({ message_id: ['message-1'], data: [], error: [] })(target, 'image');
});
test('generic adapter success responses retain their behavior', async () => {
  for (const result of [true, { message_id: 'message-1' }, { id: 'message-1' }, { status: 'ok' }]) await sender(result)(target, 'image');
  for (const result of [false, null, undefined]) await assert.rejects(sender(result)(target, 'image'), /发送接口没有确认成功/);
});
test('private and group routes preserve bot, recipient and message', async () => {
  const calls = [], send = sender(true, calls), message = { type: 'image', file: 'fixture' };
  await send(target, message);
  await send({ ...target, type: 'group' }, message);
  assert.deepEqual(calls.map(c => c.route), ['private', 'group']);
  for (const call of calls) assert.deepEqual(call.args, ['bot-test', 'target-test', message]);
});
test('adapter exceptions propagate without being treated as successful delivery', async () => {
  const error = new Error('transport unavailable');
  const send = vm.runInNewContext(`(${code})`, { Bot: { sendFriendMsg: async () => { throw error; } } });
  await assert.rejects(send(target, 'image'), e => e === error);
});
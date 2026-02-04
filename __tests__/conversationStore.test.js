import assert from 'node:assert/strict';
import { createConversationStore } from '../src/core/conversationStore.js';

export async function runConversationStoreTests() {
  const tests = [];

  tests.push(async () => {
    const store = createConversationStore({ ttlMs: 1000, maxTurns: 4 });
    store.appendTurn('chat-a', 'user', 'hola');
    store.appendTurn('chat-a', 'assistant', 'todo bien');
    store.appendTurn('chat-a', 'user', 'seguimos');
    store.appendTurn('chat-a', 'assistant', 'dale');
    store.appendTurn('chat-a', 'user', 'otra');

    const turns = store.getRecentTurns('chat-a', 10);
    assert.equal(turns.length, 4);
    assert.equal(turns[0].content, 'todo bien');
    assert.equal(turns[3].content, 'otra');
  });

  tests.push(async () => {
    const store = createConversationStore();
    store.setLastCard('chat-b', {
      eventName: 'UFC 312',
      date: '2026-02-07',
      fights: [
        { fighterA: 'Mario Bautista', fighterB: 'Vinicius Oliveira' },
        { fighterA: 'Umar Nurmagomedov', fighterB: 'Mike Davis' },
      ],
    });

    const resolution = store.resolveMessage('chat-b', 'que opinas de la pelea 1?');
    assert.equal(resolution.source, 'fight-index-1');
    assert.match(resolution.resolvedMessage, /Mario Bautista vs Vinicius Oliveira/);
  });

  tests.push(async () => {
    const store = createConversationStore();
    store.setLastResolvedFight('chat-c', {
      fighterA: 'Alex Pereira',
      fighterB: 'Magomed Ankalaev',
    });

    const resolution = store.resolveMessage('chat-c', 'y esa pelea como la ves?');
    assert.equal(resolution.source, 'last-resolved-fight');
    assert.match(resolution.resolvedMessage, /Alex Pereira vs Magomed Ankalaev/);
  });

  for (const test of tests) {
    await test();
  }

  console.log('All conversationStore tests passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runConversationStoreTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

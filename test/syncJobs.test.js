import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import Match from '../src/models/Match.js';
import { config } from '../src/config/index.js';
import { startSync, getJob, publicJob } from '../src/services/syncJobs.js';

// DB と Riot API を差し替えて、「足りない試合だけ裏で取得する」流れを確かめる
const realGet = axios.get;
const realFind = Match.find;
const realUpdate = Match.updateOne;
test.before(() => { config.riotApiKey = 'RGAPI-test'; });
test.afterEach(() => { axios.get = realGet; Match.find = realFind; Match.updateOne = realUpdate; });

const rawMatch = (id) => ({
  metadata: { matchId: id, participants: ['a'] },
  info: { gameCreation: 1700000000000, gameDuration: 1800, queueId: 420, gameVersion: '15.3.1', participants: [{ puuid: 'a', kills: 1 }] }
});
const waitDone = async (job) => { for (let i = 0; i < 100 && job.state === 'running'; i++) await new Promise((r) => setTimeout(r, 10)); };

test('DB にある試合は取得せず、足りない試合だけ取得して進捗を数える', async () => {
  const fetched = [];
  const saved = [];
  axios.get = async (url) => {
    if (url.endsWith('/ids')) return { data: ['JP1_1', 'JP1_2', 'JP1_3'], headers: {} };
    const id = url.split('/').pop();
    fetched.push(id);
    return { data: rawMatch(id), headers: {} };
  };
  Match.find = () => ({ select: () => ({ lean: async () => [{ matchId: 'JP1_1' }] }) });
  Match.updateOne = async (filter) => { saved.push(filter.matchId); return {}; };

  const puuid = 'sync-test-puuid-0000000000000000000000000001';
  const job = startSync(puuid, { count: 20 });
  assert.equal(job.state, 'running');
  await waitDone(job);

  assert.equal(job.state, 'done');
  assert.deepEqual(fetched.sort(), ['JP1_2', 'JP1_3']);
  assert.deepEqual(saved.sort(), ['JP1_2', 'JP1_3']);
  assert.equal(job.total, 2);
  assert.equal(job.done, 2);
  assert.equal(job.added, 2);

  // 同じ条件で続けて呼んでも、新しい処理は始めない
  assert.equal(startSync(puuid, { count: 20 }).id, job.id);
  assert.equal(getJob(job.id), job);
  assert.equal(publicJob(job).state, 'done');
});

test('一部の試合の取得に失敗しても、残りは取得して完了する', async () => {
  axios.get = async (url) => {
    if (url.endsWith('/ids')) return { data: ['JP1_10', 'JP1_11'], headers: {} };
    if (url.endsWith('JP1_10')) { const e = new Error('bad'); e.response = { status: 404, headers: {}, data: {} }; throw e; }
    return { data: rawMatch('JP1_11'), headers: {} };
  };
  Match.find = () => ({ select: () => ({ lean: async () => [] }) });
  Match.updateOne = async () => ({});

  const job = startSync('sync-test-puuid-0000000000000000000000000002', { count: 20 });
  await waitDone(job);
  assert.equal(job.state, 'done');
  assert.equal(job.added, 1);
  assert.equal(job.failed, 1);
  assert.equal(job.done, 2);
});

test('試合 ID の取得に失敗したら error になり、理由が入る', async () => {
  axios.get = async () => { const e = new Error('rate'); e.response = { status: 404, headers: {}, data: { status: { message: 'Data not found' } } }; throw e; };
  const job = startSync('sync-test-puuid-0000000000000000000000000003', { count: 20 });
  await waitDone(job);
  assert.equal(job.state, 'error');
  assert.ok(job.error);
});

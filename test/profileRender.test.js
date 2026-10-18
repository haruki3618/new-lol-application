import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ejs from 'ejs';
import { fileURLToPath } from 'node:url';
import { makeHelpers } from '../src/utils/ddHelpers.js';
import { timeAgo } from '../src/utils/timeAgo.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const views=path.join(root, 'views');
const h=makeHelpers({version:'15.1.1',champNames:{Ahri:'アーリ'},champKeyToId:{},spells:{},runes:{}});
const pl=(n,me)=>({championName:'Ahri',name:'A#'+n,isMe:me,kills:1,deaths:2,assists:3,items:[0,1],cs:100,visionScore:10,damage:1000,gold:5000,score:5,champLevel:10});
const match={matchId:'JP1_1',win:true,queueName:'ランク',gameDuration:1800,gameCreation:Date.now()-3600e3,championName:'Ahri',champLevel:15,spell1:1,spell2:2,keystone:1,subStyle:2,position:'MIDDLE',kills:5,deaths:2,assists:7,kda:'6.0',killParticipation:55,score:7.2,label:'MVP',rank:1,cs:200,visionScore:20,items:[1,2,0],teams:[{teamId:100,win:true,kills:20,deaths:10,assists:30,gold:50000,comp:null,players:[pl(1,true),pl(2)]},{teamId:200,win:false,kills:10,deaths:20,assists:15,gold:40000,comp:null,players:[pl(3),pl(4)]}]};
const data={h,timeAgo,account:{puuid:'x'.repeat(30),gameName:'テスト',tagLine:'JP1'},riotId:'テスト#JP1',summoner:{profileIconId:1,summonerLevel:100},soloEntry:null,flexEntry:null,matches:[match],recent:{games:1,wins:1,losses:0,winRate:100,avgKills:5,avgDeaths:2,avgAssists:7,kda:'6.0',avgScore:7.2},stats:{champions:[],roles:[],teammates:[],patches:[]},masteries:[],lpHistory:[],bannerChamp:'Ahri',roleLabels:{MIDDLE:'ミッド'},queueFilters:[{id:null,label:'全て'}],selectedQueue:null,count:20,updatedAt:Date.now(),sync:null};

test('timeAgo: 日本語の相対時間', () => {
  const now = 1_000_000_000_000;
  assert.equal(timeAgo(now - 5_000, now), 'たった今');
  assert.equal(timeAgo(now - 3 * 60_000, now), '3分前');
  assert.equal(timeAgo(now - 2 * 3600_000, now), '2時間前');
  assert.equal(timeAgo(now - 5 * 86400_000, now), '5日前');
  assert.equal(timeAgo(now - 90 * 86400_000, now), '3か月前');
  assert.equal(timeAgo(undefined, now), '不明');
});

test('プロフィール: ルートが渡す変数だけで描画でき、試合カードと最終更新が出る', async () => {
  const out = await ejs.renderFile(path.join(views, 'profile.ejs'), data, { views: [views] });
  assert.ok(out.includes('最終更新'));
  assert.ok(out.includes('時間前'), '試合カードの timeAgo が描画される');
  assert.ok(out.includes('data-collapse'));
});

test('プロフィールのルート: timeAgo を画面に渡している（渡し忘れると画面が 500 になる）', () => {
  const src = fs.readFileSync(path.join(root, 'routes', 'profile.js'), 'utf8');
  assert.match(src, /res\.render\('profile',[\s\S]*?\btimeAgo,/);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(source, 'index.html should contain a script');
const fileInputTag = html.match(/<input\s+id="backup-file"[^>]*>/)?.[0];
assert.ok(fileInputTag, 'index.html should contain the backup file input');
assert.doesNotMatch(fileInputTag, /\saccept=/i, '.ee must not be blocked by the native file picker');

const elements = new Map();
const element = () => ({
  addEventListener() {},
  classList: { add() {}, remove() {}, toggle() {} },
  style: {},
  textContent: '',
  disabled: false,
  checked: false,
  value: '',
  files: [],
  append() {},
});
const document = {
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  },
  querySelector() { return { value: 'ephone' }; },
  // 目标单选框的监听是在加载时批量挂的，没有真实 DOM 时给个空列表即可
  querySelectorAll() { return []; },
  createElement: element,
  // 脚本在加载时就给 document 挂了拖放监听
  addEventListener() {},
  body: { appendChild() {}, removeChild() {} },
};
const context = vm.createContext({
  console,
  document,
  window: globalThis,
  Blob,
  Response,
  TextDecoder,
  TextEncoder,
  Uint8Array,
  DataView,
  DecompressionStream,
  CompressionStream,
  btoa,
  atob,
  URL,
  setTimeout,
  clearTimeout,
});
new vm.Script(source, { filename: 'index.html' }).runInContext(context);

const ephone = {
  version: 3,
  timestamp: 1,
  data: {
    chats: [
      {
        id: 'c1', name: '阿糯', avatar: 'avatar.png', isGroup: false,
        settings: { aiPersona: '温柔', myPersona: '用户设定' },
        history: [
          { id: 'old-1', role: 'user', content: '你好', timestamp: 10 },
          { id: 'old-2', role: 'assistant', content: '你好呀', timestamp: 11 },
        ],
      },
      {
        id: 'g1', name: '测试群', isGroup: true, members: ['c1'],
        history: [{ role: 'assistant', charId: 'c1', content: '群里见', timestamp: 12 }],
      },
    ],
    worldBooks: [{ id: 'wb', name: '设定', content: [{ keys: ['城'], content: '天空城' }] }],
  },
};

const hand = context.toSullyBackup('sully-hand', 'ephone', ephone);
assert.equal(hand.version, 3);
assert.equal(hand.characters.length, 1);
assert.equal(hand.groups.length, 1);
assert.equal(hand.messages.length, 3);
assert.equal(hand.messages[2].groupId, 'g1');
assert.equal(hand.worldbooks[0].content, '天空城');
assert.equal(hand.vectorMemories, undefined);
assert.equal(hand.extraLocalStorageConfig, undefined);

const csy = context.toSullyBackup('sully-csy', 'sully-hand', {
  ...hand,
  memoryNodes: [{ id: 'n1' }],
  characterGroups: [{ id: 'cg1' }],
});
assert.equal(csy.version, 2);
assert.equal(csy.characters.length, 1);
assert.equal(csy.messages.length, 3);
assert.equal(csy.memoryNodes, undefined);
assert.equal(csy.characterGroups, undefined);

const handFromCsy = context.toSullyBackup('sully-hand', 'sully-csy', {
  ...csy,
  vectorMemories: [{ id: 'vm1' }],
  extraLocalStorageConfig: { token: 'secret' },
});
assert.equal(handFromCsy.version, 3);
assert.equal(handFromCsy.vectorMemories, undefined);
assert.equal(handFromCsy.extraLocalStorageConfig, undefined);

const ephoneAgain = context.toEphoneCompatible('sully-hand', hand);
assert.equal(ephoneAgain.data.chats.length, 2);
assert.equal(ephoneAgain.data.chats[0].history.length, 2);
assert.equal(ephoneAgain.data.chats[1].history.length, 1);

function storedZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, raw] of Object.entries(files)) {
    const filename = Buffer.from(name);
    const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    locals.push(local, filename, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, filename);
    offset += local.length + filename.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const pngBytes = Buffer.from([1, 2, 3, 4]);
const csyZip = storedZip({
  'data.json': JSON.stringify({
    version: 2,
    timestamp: 2,
    characters: [{ id: 'c1', name: '阿糯', avatar: 'assets/a.png' }],
    messages: [],
  }),
  'assets/a.png': pngBytes,
});
const csyRead = await context.readZipBackup({ arrayBuffer: async () => csyZip });
assert.equal(csyRead.format, 'sully-csy');
assert.equal(csyRead.data.characters[0].avatar, 'data:image/png;base64,AQIDBA==');

const handZip = storedZip({
  'manifest.json': JSON.stringify({
    formatVersion: 2,
    stores: { characters: { parts: 1, count: 1 }, messages: { parts: 1, count: 0 } },
  }),
  'metadata.json': JSON.stringify({ version: 3, timestamp: 3 }),
  'stores/characters.000.json': JSON.stringify([{ id: 'c2', name: '手抓角色' }]),
  'stores/messages.000.json': '[]',
});
const handRead = await context.readZipBackup({ arrayBuffer: async () => handZip });
assert.equal(handRead.format, 'sully-hand');
assert.equal(handRead.data.characters[0].name, '手抓角色');

// formatVersion: 3 是真实全量导出（mode: "full"），不应被当作分片版本报错。
const handZipV3 = storedZip({
  'manifest.json': JSON.stringify({
    formatVersion: 3,
    mode: 'full',
    stores: { characters: { parts: 1, count: 1 }, messages: { parts: 1, count: 0 } },
  }),
  'metadata.json': JSON.stringify({ version: 3, timestamp: 3 }),
  'stores/characters.000.json': JSON.stringify([{ id: 'c3', name: '手抓角色V3' }]),
  'stores/messages.000.json': '[]',
});
const handReadV3 = await context.readZipBackup({ arrayBuffer: async () => handZipV3 });
assert.equal(handReadV3.format, 'sully-hand', 'formatVersion: 3 的全量备份应识别为 sully-hand');
assert.equal(handReadV3.data.characters[0].name, '手抓角色V3');

const nuojiji = {
  version: 5,
  data: {
    structuredDB: {
      characters: [
        { id: 'dante', name: 'Dante', description: '天文学家', imageRef: 1 },
        { id: 'charlie', name: 'Charlie', description: '酒吧老板', image: 'https://example.test/charlie.png' },
      ],
      users: [{ id: 'Niki', name: 'Niki', avatarRef: 2 }],
      imageStore: [
        { id: 1, data: 'data:image/png;base64,ZA==' },
        { id: 2, data: 'data:image/png;base64,dQ==' },
      ],
      globalSettings: [{ key: 'apiSettings', value: {
        mainApiUrl: 'https://private.example', mainApiKey: 'sk-secret', mainApiModel: 'model-a',
      } }],
      messages: [
        { characterId: 'dante', sender: 'me', text: '你好', timestamp: 1 },
        { characterId: 'g1', sender: 'them', senderCharId: 'dante', text: '群里好', timestamp: 2 },
        { characterId: 'charlie', groupId: 'g1', sender: 'them', text: '我也在', timestamp: 3 },
      ],
      groupChats: [{ groups: [{ id: 'g1', name: '测试群', members: ['dante', 'charlie'] }] }],
      worldBooks: [{ id: 'wb1', title: '设定', entries: [{ uid: 'e1', keys: '关键词', name: '条目', content: '内容' }] }],
    },
  },
};

assert.equal(context.isNuojijiBackup(nuojiji), true);
const nuojijiRead = await context.readBackup({
  name: 'nuojiji_backup.json',
  text: async () => JSON.stringify(nuojiji),
});
assert.equal(nuojijiRead.format, 'nuojiji');
const nuojijiEphone = context.toEphoneCompatible('nuojiji', nuojiji).data;
assert.equal(nuojijiEphone.chats.length, 3);
assert.equal(nuojijiEphone.chats[0].history[0].role, 'user');
assert.equal(nuojijiEphone.chats[2].history.length, 2);
assert.equal(nuojijiEphone.chats[2].history[1].senderId, 'charlie');
assert.equal(nuojijiEphone.apiConfig.mainApiKey, 'sk-secret');
assert.equal(nuojijiEphone.apiConfig.mainApiUrl, 'https://private.example');
const nuojijiOctopus = context.toOctopusBackup('nuojiji', nuojiji);
assert.equal(nuojijiOctopus.characters.length, 2);
assert.equal(nuojijiOctopus.groups[0].history.length, 2);
assert.equal(nuojijiOctopus.worldBooks[0].content, '[备注: 条目]\n[关键词: 关键词]\n内容');

const reverseNuojiji = context.toNuojijiBackup('ephone', nuojijiEphone);
assert.equal(reverseNuojiji.version, 5);
assert.equal(reverseNuojiji.data.structuredDB.characters.length, 2);
assert.equal(reverseNuojiji.data.structuredDB.groups?.length || 0, 0);
assert.equal(reverseNuojiji.data.structuredDB.messages.length, 3);
assert.equal(reverseNuojiji.data.structuredDB.groupChats[0].groups.length, 1);
assert.equal(reverseNuojiji.data.structuredDB.messages[2].groupId, 'g1');
assert.equal(reverseNuojiji.data.structuredDB.globalSettings[0].value.mainApiKey, 'sk-secret');

const cloneNuojijiFixture = value => JSON.parse(JSON.stringify(value));
// Current Nuojiji (app 6.9.x, backup version 5) filters the roster by type
// and restores chat visibility from a per-user userState table row.
function assertNuojijiVisible(backup, expectedCharacters, expectedChats, expectedMessages) {
  const db = backup.data.structuredDB;
  assert.ok(Object.values(db).every(Array.isArray), 'structuredDB tables must contain arrays of rows');
  const uid = db.users[0].uid;
  assert.equal(db.globalSettings.find(row => row.key === 'nuojiji_current_profile_user_id')?.value, uid);
  assert.equal(backup.data.localStorage.nuojiji_current_profile_user_id, uid);
  assert.equal(db.characters.filter(character => (character.type || 'main') === 'main').length, expectedCharacters);
  assert.ok(db.characters.every(character => Array.isArray(character.boundTo) && Array.isArray(character.worldBook)));
  const state = db.userState.find(row => row.userId === uid);
  assert.ok(state, 'the imported user needs a userState row');
  assert.equal(state.activeChatIds.length, expectedChats);
  const chatIds = new Set([...db.characters.map(row => row.id), ...db.groupChats.flatMap(row => row.groups.map(group => group.id))]);
  assert.ok(state.activeChatIds.every(id => chatIds.has(id)));
  const visibleMessages = db.messages.filter(row => row.userId === uid && state.activeChatIds.includes(row.characterId));
  assert.equal(visibleMessages.length, expectedMessages);
  assert.ok(db.groupChats.every(row => row.userId === uid));
  assert.equal(backup.metadata.itemCount.structuredDB, Object.values(db).reduce((sum, rows) => sum + rows.length, 0));
}

assertNuojijiVisible(reverseNuojiji, 2, 3, 3);
const currentNuojijiInput = cloneNuojijiFixture(ephone);
currentNuojijiInput.data.globalSettings = { name: 'Imported user', avatar: 'data:image/png;base64,dQ==', bio: 'Test persona' };
currentNuojijiInput.data.chats[0].isPinned = true;
currentNuojijiInput.data.chats[0].settings.linkedWorldBookIds = ['wb'];
const currentNuojiji = context.toNuojijiBackup('ephone', currentNuojijiInput);
assertNuojijiVisible(currentNuojiji, 1, 2, 3);
assert.deepEqual(cloneNuojijiFixture(currentNuojiji.data.structuredDB.userState[0].pinnedChatIds), ['c1']);
assert.deepEqual(cloneNuojijiFixture(currentNuojiji.data.structuredDB.characters[0].worldBook), ['wb']);
assert.equal(currentNuojiji.data.structuredDB.users[0].avatar, currentNuojijiInput.data.globalSettings.avatar);
assert.equal(context.nuojijiToEphone(currentNuojiji).data.globalSettings.avatar, currentNuojijiInput.data.globalSettings.avatar);

const yuanNuojiji = context.toNuojijiBackup('yuanuwu', {
  version: 1, timestamp: 1, ...cloneNuojijiFixture(currentNuojijiInput.data),
});
assertNuojijiVisible(yuanNuojiji, 1, 2, 3);
assertNuojijiVisible(context.toNuojijiBackup('ephone', { version: 3, data: { chats: [] } }), 0, 0, 0);

const reverseFromOctopus = context.toNuojijiBackup('octopus', {
  ...nuojijiOctopus,
  characters: nuojijiOctopus.characters,
  groups: nuojijiOctopus.groups,
});
assert.equal(reverseFromOctopus.data.structuredDB.characters.length, 2);
assert.equal(reverseFromOctopus.data.structuredDB.groupChats[0].groups.length, 1);

// ===== 弯弯小手机 =====

const wanwan = {
  version: 1,
  exportedAt: 1700000000000,
  appName: '弯弯',
  config: [
    { key: 'apiSettings', value: { mainApiKey: 'sk-wanwan' } },
    { key: 'lorebooks', value: [{
      id: 'lb1', name: '天空城', scope: 'global', charIds: [], enabled: true,
      entries: [
        { id: 'e1', title: '城主', content: '城主姓白', keywords: ['城主', '白'], position: 'middle', enabled: true },
        { id: 'e2', title: '禁忌', content: '夜里不许出城', keywords: [], position: 'after', enabled: false },
      ],
    }] },
  ],
  characters: [
    { id: 1, type: 'user', name: '我', nick: '小我', description: '玩家人设', avatar: 'me.png' },
    { id: 2, type: 'char', name: '弯弯', nick: '弯弯酱', description: '开朗', avatar: 'wan.png' },
    { id: 3, type: 'char', name: '阿绿', description: '沉稳', avatar: 'lv.png' },
  ],
  chats: [{ id: 11, charId: 2, ownerUid: 1, createdAt: 100 }],
  messages: [
    { id: 1, chatId: 11, charId: 2, role: 'user', content: '在吗', createdAt: 110 },
    { id: 2, chatId: 11, charId: 2, role: 'assistant', content: '在的', createdAt: 120 },
    { id: 3, chatId: 11, charId: 2, role: 'user', content: '__IMG__data:image/png;base64,AAA', createdAt: 130 },
  ],
  groupChats: [{ id: 21, name: '三人行', ownerUid: 1, ownerId: 1, members: [2, 3, 1], avatar: 'g.png', createdAt: 90 }],
  groupMessages: [
    { id: 1, groupId: 21, senderId: 1, role: 'user', content: '晚上吃什么', createdAt: 200 },
    { id: 2, groupId: 21, senderId: 3, role: 'assistant', content: '火锅', createdAt: 210 },
  ],
  stickers: [{ id: 1, name: '笑', image: 'sticker.png' }],
  localStorage: {},
};

assert.equal(context.isWanwanBackup(wanwan), true);
assert.equal(context.isWanwanBackup(ephone), false);

const wanwanStats = context.collectStats('wanwan', wanwan);
assert.equal(wanwanStats.characters, 2, 'type:user 不该算成联系人');
assert.equal(wanwanStats.groups, 1);
assert.equal(wanwanStats.messages, 5);
assert.equal(wanwanStats.worldBooks, 1);

const wanwanEphone = context.toEphoneCompatible('wanwan', wanwan).data;
assert.equal(wanwanEphone.chats.length, 2);
const wanwanPrivate = wanwanEphone.chats.find((chat) => !chat.isGroup);
assert.equal(wanwanPrivate.name, '弯弯酱');
assert.equal(wanwanPrivate.history.length, 3);
assert.equal(wanwanPrivate.history[0].role, 'user');
assert.equal(wanwanPrivate.history[2].content, 'data:image/png;base64,AAA', '__IMG__ 前缀应被剥掉');
const wanwanGroup = wanwanEphone.chats.find((chat) => chat.isGroup);
assert.equal(wanwanGroup.members.length, 2, '群成员不应包含用户自己');
assert.equal(wanwanGroup.history.length, 2);
assert.equal(wanwanGroup.history[1].senderName, '阿绿');
assert.equal(wanwanEphone.globalSettings[0].name, '小我');
assert.equal(wanwanEphone.worldBooks.length, 1, '弯弯的世界书要带过来');
assert.equal(wanwanEphone.worldBooks[0].name, '天空城');
assert.deepEqual(wanwanEphone.worldBooks[0].content[0].keys, ['城主', '白']);
assert.equal(wanwanEphone.worldBooks[0].content[0].comment, '城主');
assert.equal(wanwanEphone.worldBooks[0].content[1].enabled, false, '禁用状态不能丢');

// ephone → 弯弯
const toWanwan = context.toWanwanBackup('ephone', ephone);
assert.equal(toWanwan.version, 1);
assert.equal(toWanwan.appName, '弯弯');
assert.equal(toWanwan.characters[0].type, 'user');
assert.equal(toWanwan.characters.length, 2, '用户 + 1 个角色');
assert.equal(toWanwan.chats.length, 1);
assert.equal(toWanwan.messages.length, 2);
assert.equal(toWanwan.messages[0].role, 'user');
assert.equal(toWanwan.groupChats.length, 1);
assert.ok(toWanwan.groupChats[0].members.includes(toWanwan.characters[0].id), '群成员应含用户');
assert.equal(toWanwan.groupMessages.length, 1);
assert.equal(toWanwan.groupMessages[0].senderId, toWanwan.characters[1].id);
// 弯弯是流式解析导入的，读到任何一张表之前必须先见到 version 和 appName，
// 否则它会直接报「备份头部无效或字段顺序不受支持」。键序是硬约束，不是风格问题。
const wanwanKeys = Object.keys(toWanwan);
assert.ok(wanwanKeys.indexOf('version') < wanwanKeys.indexOf('config'), 'version 必须在任何表之前');
assert.ok(wanwanKeys.indexOf('appName') < wanwanKeys.indexOf('config'), 'appName 必须在任何表之前');
assert.deepEqual(
  wanwanKeys.filter((key) => !['version', 'exportedAt', 'appName', 'localStorage'].includes(key)),
  ['config', 'characters', 'chats', 'messages', 'groupChats', 'groupMessages',
    'moments', 'finance', 'offlineChats', 'stickers', 'stickerCategories', 'memories',
    'memoryRuns', 'callRecords', 'smsConversations', 'smsMessages', 'imageBlobs',
    'doorModules', 'doorResults', 'avgSaves', 'avgConfigs', 'mcpServers', 'mcpToolTraces'],
  '表名要跟弯弯 data-stream.js 里的 TABLES 完全一致');

// 世界书要落到 config 的 lorebooks 键，弯弯就是从那里读的
const toWanwanLore = toWanwan.config.find((row) => row.key === 'lorebooks')?.value;
assert.equal(toWanwanLore.length, 1);
assert.equal(toWanwanLore[0].name, '设定');
assert.equal(toWanwanLore[0].scope, 'global');
assert.deepEqual(toWanwanLore[0].entries[0].keywords, ['城']);
assert.equal(toWanwanLore[0].entries[0].content, '天空城');
assert.equal(toWanwanLore[0].entries[0].position, 'middle');

// 世界书往返：弯弯 → ephone → 弯弯，条目内容与关键词不应丢
const loreRoundTrip = context.toWanwanBackup('ephone', context.toEphoneCompatible('wanwan', wanwan))
  .config.find((row) => row.key === 'lorebooks')?.value;
assert.equal(loreRoundTrip[0].name, '天空城');
assert.deepEqual(loreRoundTrip[0].entries.map((entry) => entry.content), ['城主姓白', '夜里不许出城']);
assert.deepEqual(loreRoundTrip[0].entries[0].keywords, ['城主', '白']);
assert.equal(loreRoundTrip[0].entries[1].enabled, false);

// 弯弯 → 弯弯（同格式直通）
const wanwanRoundTrip = context.toWanwanBackup('wanwan', wanwan);
assert.equal(wanwanRoundTrip.characters.length, 3);

// 弯弯 → 章鱼机 / 糯米机，确认能走完整条链路
const wanwanOctopus = context.toOctopusBackup('wanwan', wanwan);
assert.equal(wanwanOctopus.characters.length, 1);
assert.equal(wanwanOctopus.groups.length, 1);
const wanwanSully = context.toSullyBackup('sully-hand', 'wanwan', wanwan);
assert.equal(wanwanSully.version, 3);
assert.equal(wanwanSully.messages.length, 5);

// ===== Float 小手机 =====

const floatData = {
  __float: true,
  version: 1,
  idb: {
    AiPhoneChatDB: {
      messages: [
        { id: 'm1', sessionId: 's1', role: 'user', content: '早', createdAt: '2024-01-01T00:00:00.000Z', order: 0 },
        { id: 'm2', sessionId: 's1', role: 'assistant', content: '早安', createdAt: '2024-01-01T00:01:00.000Z', order: 1 },
        { id: 'm3', sessionId: 's1', role: 'tool', content: '{}', createdAt: '2024-01-01T00:02:00.000Z', order: 2 },
        { id: 'm4', sessionId: 's2', role: 'assistant', characterId: 'ch2', content: '群消息', createdAt: '2024-01-01T00:03:00.000Z', order: 0 },
      ],
      sessions: [
        { id: 's1', contactId: 'ct1', unreadCount: 0, updatedAt: '2024-01-01T00:01:00.000Z', isPinned: false },
        { id: 's2', contactId: '', unreadCount: 0, updatedAt: '2024-01-01T00:03:00.000Z', isPinned: false,
          isGroup: true, groupName: 'Float 群', participantIds: ['ch1', 'ch2'] },
      ],
      contacts: [{ id: 'ct1', characterId: 'ch1', nickname: '小浮', addedAt: '2024-01-01T00:00:00.000Z' }],
    },
    AiPhoneSettingsDB: {
      worldBooks: [{
        id: 'fwb1', name: '漂浮之城', description: '', createdAt: 1, updatedAt: 1,
        entries: [
          { uid: 'e1', key: '云,城', content: '城在云上', comment: '设定', disable: false,
            position: 'before_char', insertion_order: 10 },
          { uid: 'e2', key: '', content: '禁飞区', comment: '规则', disable: true,
            position: 'before_char', insertion_order: 20 },
        ],
      }],
    },
  },
  kv: {
    ai_phone_characters_v1: [
      { id: 'ch1', name: '浮浮', avatar: 'f1.png', persona: '安静', createdAt: 'x', updatedAt: 'x' },
      { id: 'ch2', name: '游游', avatar: 'f2.png', persona: '活泼', createdAt: 'x', updatedAt: 'x' },
      { id: 'ch3', name: '没聊过', avatar: null, persona: '孤独', createdAt: 'x', updatedAt: 'x' },
    ],
    ai_phone_user_identities_v1: [{ id: 'u1', name: '主人', avatar: 'u.png', persona: '我的设定' }],
  },
  localStorage: {},
  characters: [
    { id: 'ch1', name: '浮浮', avatar: 'f1.png', persona: '安静', createdAt: 'x', updatedAt: 'x' },
    { id: 'ch2', name: '游游', avatar: 'f2.png', persona: '活泼', createdAt: 'x', updatedAt: 'x' },
    { id: 'ch3', name: '没聊过', avatar: null, persona: '孤独', createdAt: 'x', updatedAt: 'x' },
  ],
  contacts: [{ id: 'ct1', characterId: 'ch1', nickname: '小浮', addedAt: '2024-01-01T00:00:00.000Z' }],
  sessions: [
    { id: 's1', contactId: 'ct1', unreadCount: 0, updatedAt: '2024-01-01T00:01:00.000Z', isPinned: false },
    { id: 's2', contactId: '', unreadCount: 0, updatedAt: '2024-01-01T00:03:00.000Z', isPinned: false,
      isGroup: true, groupName: 'Float 群', participantIds: ['ch1', 'ch2'] },
  ],
  messages: [
    { id: 'm1', sessionId: 's1', role: 'user', content: '早', createdAt: '2024-01-01T00:00:00.000Z', order: 0 },
    { id: 'm2', sessionId: 's1', role: 'assistant', content: '早安', createdAt: '2024-01-01T00:01:00.000Z', order: 1 },
    { id: 'm3', sessionId: 's1', role: 'tool', content: '{}', createdAt: '2024-01-01T00:02:00.000Z', order: 2 },
    { id: 'm4', sessionId: 's2', role: 'assistant', characterId: 'ch2', content: '群消息', createdAt: '2024-01-01T00:03:00.000Z', order: 0 },
  ],
};

assert.equal(context.isFloatManifest({ format: 'ai-phone-backup', version: 2, modules: [] }), true);
assert.equal(context.isFloatManifest({ formatVersion: 2, stores: {} }), false);

const floatEphone = context.toEphoneCompatible('float', floatData).data;
// 两个会话 + 两张没有单聊会话的角色卡（ch2 只在群里、ch3 完全没聊过）
assert.equal(floatEphone.chats.length, 4);
const floatPrivate = floatEphone.chats.find((chat) => chat.id === 's1');
assert.equal(floatPrivate.name, '小浮');
assert.equal(floatPrivate.history.length, 2, 'tool 消息应被滤除');
assert.equal(floatPrivate.history[0].role, 'user');
const floatGroup = floatEphone.chats.find((chat) => chat.isGroup);
assert.equal(floatGroup.name, 'Float 群');
assert.equal(floatGroup.history[0].senderName, '游游');
assert.ok(floatEphone.chats.some((chat) => chat.name === '没聊过'), '未开会话的角色卡不能丢');
assert.ok(floatEphone.chats.some((chat) => chat.name === '游游' && !chat.isGroup),
  '只在群里出现的角色也要有独立联系人，否则导入后群成员没有角色卡');
assert.equal(floatEphone.globalSettings[0].name, '主人');
assert.equal(floatEphone.worldBooks.length, 1);
// 展开一层：split() 产出的数组来自 vm realm，deepStrictEqual 会比原型
assert.deepEqual([...floatEphone.worldBooks[0].content[0].keys], ['云', '城'], '逗号串关键词要拆开');
assert.equal(floatEphone.worldBooks[0].content[1].enabled, false, 'disable:true 要翻译成 enabled:false');

const floatStats = context.collectStats('float', floatData);
assert.equal(floatStats.characters, 3);
assert.equal(floatStats.groups, 1);
assert.equal(floatStats.messages, 4);

// ephone → Float，并把生成的 ZIP 再读回来验证结构闭环
const floatBlob = await context.toFloatBackup('ephone', ephone);
const floatEntries = await context.readZipEntries({
  name: 'float.zip',
  arrayBuffer: () => floatBlob.arrayBuffer(),
});
const floatMap = context.zipEntryMap(floatEntries);
const floatManifest = JSON.parse(new TextDecoder().decode(floatMap.get('manifest.json')));
assert.equal(floatManifest.format, 'ai-phone-backup');
assert.equal(context.isFloatManifest(floatManifest), true);

const chatModule = JSON.parse(new TextDecoder().decode(floatMap.get('modules/chat/000.json')));
assert.equal(chatModule.moduleId, 'chat');
assert.equal(chatModule.sources[0].dbName, 'AiPhoneChatDB');
const storeByName = Object.fromEntries(chatModule.sources[0].stores.map((store) => [store.name, store]));
assert.equal(storeByName.sessions.records.length, 2);
assert.equal(storeByName.contacts.records.length, 1, '群聊不产生 contact');
assert.equal(storeByName.messages.records.length, 3);
assert.equal(storeByName.messages.records[0].value.role, 'user');
assert.equal(storeByName.messages.keyPath, 'id');

const charModule = JSON.parse(new TextDecoder().decode(floatMap.get('modules/characters/000.json')));
const charKv = charModule.sources[0].records.find((record) => record.key === 'ai_phone_characters_v1');
assert.equal(JSON.parse(charKv.value).length, 1);

// 世界书与身份/API 键必须落在 settings 模块（Float 的模块登记表就是这么分的）
const settingsModule = JSON.parse(new TextDecoder().decode(floatMap.get('modules/settings/000.json')));
const settingsIdb = settingsModule.sources.find((source) => source.type === 'indexeddb');
assert.equal(settingsIdb.dbName, 'AiPhoneSettingsDB');
const floatBook = settingsIdb.stores[0].records[0].value;
assert.equal(floatBook.name, '设定');
assert.equal(floatBook.entries[0].key, '城', '关键词要合成逗号串');
assert.equal(floatBook.entries[0].disable, false);
assert.equal(floatBook.entries[0].position, 'before_char');
const settingsKv = settingsModule.sources.find((source) => source.type === 'kv');
assert.ok(settingsKv.records.some((record) => record.key === 'ai_phone_user_identities_v1'));

// 世界书往返：Float → ephone → Float
const floatLoreRoundTrip = context.toEphoneCompatible('float', floatData).data.worldBooks;
const floatLoreBack = await context.toFloatBackup('ephone', {
  version: 3, timestamp: 1, data: { chats: [], worldBooks: floatLoreRoundTrip },
});
const floatLoreMap = context.zipEntryMap(await context.readZipEntries({
  name: 'lore.zip', arrayBuffer: () => floatLoreBack.arrayBuffer(),
}));
const loreSettings = JSON.parse(new TextDecoder().decode(floatLoreMap.get('modules/settings/000.json')));
const loreBook = loreSettings.sources.find((s) => s.type === 'indexeddb').stores[0].records[0].value;
assert.equal(loreBook.name, '漂浮之城');
assert.equal(loreBook.entries[0].key, '云,城');
assert.equal(loreBook.entries[1].disable, true, '禁用条目往返后仍是禁用');

// 把刚生成的 ZIP 当成源文件重新装配，确认 Float→Float 链路自洽
const reassembled = context.assembleFloatBackup(floatMap, floatManifest);
assert.equal(reassembled.characters.length, 1);
assert.equal(reassembled.sessions.length, 2);
assert.equal(reassembled.messages.length, 3);
const reassembledEphone = context.toEphoneCompatible('float', reassembled).data;
assert.equal(reassembledEphone.chats.length, 2);

// Float → 弯弯 / 章鱼机
const floatToWanwan = context.toWanwanBackup('float', floatData);
assert.equal(floatToWanwan.appName, '弯弯');
assert.equal(floatToWanwan.messages.length, 2);
assert.equal(floatToWanwan.groupChats.length, 1);
const floatOctopus = context.toOctopusBackup('float', floatData);
assert.equal(floatOctopus.groups.length, 1);

// 弯弯 → Float
const wanwanToFloatBlob = await context.toFloatBackup('wanwan', wanwan);
assert.ok(wanwanToFloatBlob.size > 0);
const wanwanFloatMap = context.zipEntryMap(await context.readZipEntries({
  name: 'w.zip',
  arrayBuffer: () => wanwanToFloatBlob.arrayBuffer(),
}));
const wanwanFloatChat = JSON.parse(new TextDecoder().decode(wanwanFloatMap.get('modules/chat/000.json')));
const wanwanFloatStores = Object.fromEntries(
  wanwanFloatChat.sources[0].stores.map((store) => [store.name, store]));
assert.equal(wanwanFloatStores.messages.records.length, 5);
assert.equal(wanwanFloatStores.sessions.records.length, 2);

// 糯叽机 → 弯弯 / Float（用户明确要求这条链路可用）
assert.equal(context.targetSupportsNuojiji('wanwan'), true);
assert.equal(context.targetSupportsNuojiji('float'), true);
const nuojijiToWanwan = context.toWanwanBackup('nuojiji', nuojiji);
assert.equal(nuojijiToWanwan.characters.length, 3, '用户 + 2 个角色');
assert.ok((await context.toFloatBackup('nuojiji', nuojiji)).size > 0);

// ===== 全格式互转矩阵 =====
// 用户要的是「弯弯 / Float 与 330、章鱼机、糯叽机、zz、糯米机双向互通」，
// 这里把每条方向都真跑一遍，任何一条抛异常或丢掉全部聊天都会在这里暴露。

const octopusSource = context.toOctopusBackup('ephone', ephone);
const zzSource = context.toZzBackup('ephone', ephone);
const nuojijiSource = context.toNuojijiBackup('ephone', ephone);
const handSource = context.toSullyBackup('sully-hand', 'ephone', ephone);
const csySource = context.toSullyBackup('sully-csy', 'ephone', ephone);

const sources = {
  ephone,
  octopus: octopusSource,
  zz: zzSource,
  nuojiji: nuojijiSource,
  'sully-hand': handSource,
  'sully-csy': csySource,
  wanwan,
  float: floatData,
};

// 每种源格式转成弯弯与 Float
for (const [format, data] of Object.entries(sources)) {
  const asWanwan = context.toWanwanBackup(format, data);
  assert.equal(asWanwan.appName, '弯弯', `${format} → 弯弯 输出不合法`);
  assert.equal(asWanwan.version, 1, `${format} → 弯弯 版本号不对`);
  assert.ok(asWanwan.characters.length > 0, `${format} → 弯弯 一个角色都没有`);
  assert.ok(asWanwan.chats.length + asWanwan.groupChats.length > 0, `${format} → 弯弯 一个会话都没有`);

  const zipBlob = await context.toFloatBackup(format, data);
  const map = context.zipEntryMap(await context.readZipEntries({
    name: `${format}.zip`, arrayBuffer: () => zipBlob.arrayBuffer(),
  }));
  const mf = JSON.parse(new TextDecoder().decode(map.get('manifest.json')));
  assert.ok(context.isFloatManifest(mf), `${format} → Float 清单不合法`);
  const stores = JSON.parse(new TextDecoder().decode(map.get('modules/chat/000.json')))
    .sources[0].stores;
  const sessionCount = stores.find((store) => store.name === 'sessions').records.length;
  assert.ok(sessionCount > 0, `${format} → Float 一个会话都没有`);
}

// 弯弯与 Float 转成其余每种格式
for (const [format, data] of [['wanwan', wanwan], ['float', floatData]]) {
  const asOctopus = context.toOctopusBackup(format, data);
  assert.ok(asOctopus.characters.length + asOctopus.groups.length > 0, `${format} → 章鱼机 为空`);

  const asZz = context.toZzBackup(format, data);
  assert.ok(asZz.contacts.length > 0, `${format} → zz 为空`);
  assert.ok(Object.keys(asZz.chatHistory).length > 0, `${format} → zz 没有聊天记录`);

  const asNuojiji = context.toNuojijiBackup(format, data);
  assert.equal(asNuojiji.version, 5, `${format} → 糯叽机 版本号不对`);
  const nuojijiDb = asNuojiji.data.structuredDB;
  assert.ok(nuojijiDb.characters.length > 0, `${format} → 糯叽机 一个角色都没有`);
  assert.ok(nuojijiDb.messages.length > 0, `${format} → 糯叽机 没有消息`);

  for (const flavor of ['sully-hand', 'sully-csy']) {
    const asSully = context.toSullyBackup(flavor, format, data);
    assert.ok(asSully.characters.length + asSully.groups.length > 0, `${format} → ${flavor} 为空`);
    assert.ok(asSully.messages.length > 0, `${format} → ${flavor} 没有消息`);
  }

  const asEphone = context.toEphoneCompatible(format, data);
  assert.equal(asEphone.version, 3, `${format} → 330 版本号不对`);
  assert.ok(asEphone.data.chats.length > 0, `${format} → 330 为空`);
}

// ===== yuan改uwu / 1900版uwu / miya小手机 =====

// yuan改uwu：Dexie 每张表平铺到顶层。导入端只对数组 bulkPut，
// 单条表用 .get('main') 读，所以主键必须是 'main'，否则 API 与全局设置整段丢失。
const toYuan = context.toYuanUwuBackup('ephone', {
  ...ephone,
  data: {
    ...ephone.data,
    apiConfig: [{ mainApiKey: 'sk-yuan', mainApiUrl: 'https://y.example' }],
    globalSettings: [{ name: '我', avatar: 'me.png' }],
    userStickers: [{ id: 's1', url: 'sticker.png' }],
  },
});
assert.equal(toYuan.version, 1);
assert.equal(typeof toYuan.timestamp, 'number');
assert.equal(toYuan.chats.length, 2);
assert.equal(toYuan.chats[0].history.length, 2);
assert.equal(toYuan.chats[1].isGroup, true);
assert.equal(toYuan.apiConfig.id, 'main', '单条表主键必须是 main');
assert.equal(toYuan.apiConfig.mainApiKey, 'sk-yuan');
assert.equal(toYuan.globalSettings.id, 'main');
assert.equal(toYuan.userStickers.length, 1);
assert.equal(toYuan.worldBooks[0].content[0].content, '天空城');
// localStorage 恢复走的是逐键 setItem，空对象即可；对象来自 vm realm，只比内容
assert.equal(Object.keys(toYuan.localStorage).length, 0);
// 其余表必须是数组：导入端 Array.isArray 不成立就整张表跳过
for (const table of ['personaPresets', 'memories', 'qzonePosts', 'emails', 'funds']) {
  assert.ok(Array.isArray(toYuan[table]), `${table} 必须是数组`);
}
assert.equal(context.isYuanUwuBackup(toYuan), true, '生成的备份要能被自己识别回来');

// yuan改uwu → ephone → yuan改uwu，聊天与世界书不应丢
const yuanEphone = context.toEphoneCompatible('yuanuwu', toYuan).data;
assert.equal(yuanEphone.chats.length, 2);
assert.equal(yuanEphone.chats[0].history.length, 2);
assert.equal(yuanEphone.apiConfig[0].mainApiKey, 'sk-yuan');
const yuanRoundTrip = context.toYuanUwuBackup('yuanuwu', toYuan);
assert.equal(yuanRoundTrip.chats.length, 2);
assert.equal(yuanRoundTrip.apiConfig.id, 'main');

// 1900版uwu：整个 db 对象 gzip 成 .ee，识别靠 _exportVersion === '3.0'
const to1900 = context.to1900UwuBackup('ephone', ephone);
assert.equal(to1900._exportVersion, '3.0');
assert.equal(typeof to1900._exportTimestamp, 'number');
assert.equal(to1900.characters.length, 1);
assert.equal(to1900.groups.length, 1);
assert.equal(to1900.characters[0].history.length, 2);
assert.equal(to1900.groups[0].history.length, 1);
assert.equal(to1900.worldBooks[0].content, '[备注: 从章鱼机导入]\n[关键词: 城]\n天空城');
assert.equal(context.is1900UwuBackup(to1900), true, '生成的备份要能被自己识别回来');
assert.equal(context.isYuanUwuBackup(to1900), false, '不能和 yuan改uwu 撞识别');

const uwu1900Ephone = context.toEphoneCompatible('1900uwu', to1900).data;
assert.equal(uwu1900Ephone.chats.length, 2);
assert.equal(uwu1900Ephone.chats.filter((chat) => chat.isGroup).length, 1);

// miya：ZIP = manifest.json + localStorage.json + indexedDB_kv.json
const miyaBlob = await context.toMiyaBackup('ephone', ephone);
const miyaMap = context.zipEntryMap(await context.readZipEntries({
  name: 'miya.zip', arrayBuffer: () => miyaBlob.arrayBuffer(),
}));
const miyaManifest = JSON.parse(new TextDecoder().decode(miyaMap.get('manifest.json')));
assert.equal(context.isMiyaManifest(miyaManifest), true);
assert.equal(miyaManifest.app, 'miya-mini-phone');
assert.equal(miyaManifest.zipMethod, 'store');
assert.ok(miyaMap.has('localStorage.json'), '缺 localStorage.json 会让 miya 报 missing_localStorage');
assert.ok(miyaMap.has('indexedDB_kv.json'));

const miyaLs = JSON.parse(new TextDecoder().decode(miyaMap.get('localStorage.json')));
const miyaKv = JSON.parse(new TextDecoder().decode(miyaMap.get('indexedDB_kv.json')));
// localStorage 的值必须是 JSON 字符串（miya 用 setItem 原样写回），不能是对象
for (const key of ['miya-chat-meta', 'miya-contacts-v1', 'miya-worldbook-v1']) {
  assert.equal(typeof miyaLs[key], 'string', `${key} 必须是字符串`);
}
const miyaMeta = miyaKv['miya-chat-meta'];
assert.equal(miyaMeta.version, 2);
assert.equal(miyaMeta.contacts.length, 1);
assert.equal(miyaMeta.chats.length, 2);
assert.equal(miyaMeta.chats.filter((chat) => chat.type === 'group').length, 1);
assert.equal(miyaMeta.contactGroups[0].id, 'ct-default', '会话侧默认分组是短横线');
const miyaPrivate = miyaMeta.chats.find((chat) => chat.type === 'private');
assert.equal(miyaMeta.messagesByChat[miyaPrivate.id].length, 2);
assert.equal(miyaMeta.messagesByChat[miyaPrivate.id][0].role, 'user');
assert.equal(typeof miyaMeta.messagesByChat[miyaPrivate.id][0].createdAt, 'number');
const miyaGroup = miyaMeta.chats.find((chat) => chat.type === 'group');
assert.equal(miyaGroup.memberIds.length, 1);
assert.ok(miyaMeta.contacts.some((contact) => contact.id === miyaGroup.memberIds[0]),
  '群成员必须在 contacts 里，否则 miya 的 getGroupMembers 全滤空');
assert.equal(miyaKv['miya-contacts-v1'].groups[0].id, 'ct_default', '角色侧默认分组是下划线');
assert.equal(miyaKv['miya-worldbook-v1'].entries[0].content, '天空城');
assert.deepEqual([...miyaKv['miya-worldbook-v1'].entries[0].keywords], ['城']);
assert.equal(miyaKv['miya-worldbook-v1'].groups[0].id, 'grp_default');

// miya → ephone：把刚生成的 ZIP 内容当成源数据读回来
const miyaSource = { manifest: miyaManifest, localStorage: miyaLs, indexedDB_kv: miyaKv };
const miyaEphone = context.toEphoneCompatible('miya', miyaSource).data;
assert.equal(miyaEphone.chats.length, 2);
assert.equal(miyaEphone.chats.filter((chat) => chat.isGroup).length, 1);
assert.equal(miyaEphone.chats.find((chat) => !chat.isGroup).history.length, 2);
assert.equal(miyaEphone.worldBooks[0].content[0].content, '天空城');
const miyaStats = context.collectStats('miya', miyaSource);
assert.equal(miyaStats.characters, 1);
assert.equal(miyaStats.groups, 1);
assert.equal(miyaStats.messages, 3);
assert.equal(miyaStats.worldBooks, 1);

// 超过 48KB 的键 miya 只在 localStorage 留占位符，真数据在 indexedDB_kv：
// 读取端必须优先看 kv，否则真实备份会整段读空。
const spilled = {
  localStorage: {
    'miya-chat-meta': '{"__storedInIdb":true}',
    'miya-contacts-v1': '{"__storedInIdb":true}',
    'miya-worldbook-v1': '{"__storedInIdb":true}',
  },
  indexedDB_kv: miyaKv,
};
const spilledStats = context.collectStats('miya', spilled);
assert.equal(spilledStats.messages, 3, '占位符不能让消息读成 0');
assert.equal(spilledStats.characters, 1);
assert.equal(context.toEphoneCompatible('miya', spilled).data.chats.length, 2);

// 三个新目标都走 ephone 中间格式，糯叽机应当放行
for (const target of ['yuanuwu', '1900uwu', 'miya']) {
  assert.equal(context.targetSupportsNuojiji(target), true, `${target} 应支持糯叽机来源`);
}

// 每种源格式都能转到三个新目标
for (const [format, data] of Object.entries(sources)) {
  const asYuan = context.toYuanUwuBackup(format, data);
  assert.equal(asYuan.version, 1, `${format} → yuan改uwu 版本号不对`);
  assert.ok(asYuan.chats.length > 0, `${format} → yuan改uwu 一个会话都没有`);
  assert.equal(asYuan.apiConfig.id, 'main', `${format} → yuan改uwu 主键丢了`);

  const as1900 = context.to1900UwuBackup(format, data);
  assert.equal(as1900._exportVersion, '3.0', `${format} → 1900版uwu 版本号不对`);
  assert.ok(as1900.characters.length + as1900.groups.length > 0, `${format} → 1900版uwu 为空`);

  const blob = await context.toMiyaBackup(format, data);
  const map = context.zipEntryMap(await context.readZipEntries({
    name: `${format}-miya.zip`, arrayBuffer: () => blob.arrayBuffer(),
  }));
  const mf = JSON.parse(new TextDecoder().decode(map.get('manifest.json')));
  assert.ok(context.isMiyaManifest(mf), `${format} → miya 清单不合法`);
  const kv = JSON.parse(new TextDecoder().decode(map.get('indexedDB_kv.json')));
  assert.ok(kv['miya-chat-meta'].chats.length > 0, `${format} → miya 一个会话都没有`);
}

// 三个新格式作为来源，也要能转回其余目标
const newSources = {
  yuanuwu: toYuan,
  '1900uwu': to1900,
  miya: miyaSource,
};
for (const [format, data] of Object.entries(newSources)) {
  const asEphone = context.toEphoneCompatible(format, data);
  assert.equal(asEphone.version, 3, `${format} → 330 版本号不对`);
  assert.ok(asEphone.data.chats.length > 0, `${format} → 330 为空`);

  const asOctopus = context.toOctopusBackup(format, data);
  assert.ok(asOctopus.characters.length + asOctopus.groups.length > 0, `${format} → 章鱼机 为空`);

  const asWanwan = context.toWanwanBackup(format, data);
  assert.equal(asWanwan.appName, '弯弯', `${format} → 弯弯 输出不合法`);

  const asZz = context.toZzBackup(format, data);
  assert.ok(asZz.contacts.length > 0, `${format} → zz 为空`);

  const asNuojiji = context.toNuojijiBackup(format, data);
  assert.ok(asNuojiji.data.structuredDB.characters.length > 0, `${format} → 糯叽机 一个角色都没有`);

  for (const flavor of ['sully-hand', 'sully-csy']) {
    const asSully = context.toSullyBackup(flavor, format, data);
    assert.ok(asSully.characters.length + asSully.groups.length > 0, `${format} → ${flavor} 为空`);
  }

  assert.ok((await context.toFloatBackup(format, data)).size > 0, `${format} → Float 为空`);
}

// ===== 记忆迁移 =====
// 向量在备份 JSON 里的两种形态：csy 是 number[]，手抓是 Float32 的原始字节
//（Uint8Array 序列化后长成 {"0":..,"1":..}）。往返必须无损。
const vectorNumbers = [0.25, -0.5, 1, 0];
// 脚本跑在 vm 里，它造出来的数组是另一个 realm 的，deepStrictEqual 会比原型。
// 摊平成本 realm 的数组再比。
const plain = (value) => (value == null ? value : [...value]);
const vectorBytes = context.memoryVectorToBytes(vectorNumbers);
assert.equal(Object.keys(vectorBytes).length, vectorNumbers.length * 4, '每维 4 字节');
assert.deepEqual(plain(context.memoryVectorToNumbers(vectorBytes)), vectorNumbers, '向量字节往返丢精度了');
assert.deepEqual(plain(context.memoryVectorToNumbers(vectorNumbers)), vectorNumbers, 'number[] 应原样返回');

const csyWithMemory = {
  version: 2,
  characters: [{ id: 'c1', name: '阿糯' }],
  groups: [],
  messages: [],
  vectorMemories: [
    {
      id: 'vm1', charId: 'c1', title: '奶茶', content: '用户不再喝奶茶了',
      importance: 8, createdAt: 1700000000000,
      vector: vectorNumbers, modelId: 'Pro/BAAI/bge-m3',
    },
    { id: 'vm2', charId: 'c1', content: '这条已作废', importance: 3, deprecated: true },
  ],
};

// 默认（不勾选项）一条记忆都不该带过去
const handNoMemory = context.toSullyBackup('sully-hand', 'sully-csy', csyWithMemory);
assert.equal(handNoMemory.memoryNodes, undefined, '没勾记忆时不该写 memoryNodes');

// csy → 手抓：结构不同（vectorMemories vs memoryNodes+memoryVectors），必须重建
const handMemory = context.toSullyBackup('sully-hand', 'sully-csy', csyWithMemory,
  { memory: true, keepVectors: true });
assert.equal(handMemory.memoryNodes.length, 1, '作废的记忆不该带过去');
assert.equal(handMemory.memoryNodes[0].content, '用户不再喝奶茶了');
assert.equal(handMemory.memoryNodes[0].room, 'living_room', '缺房间信息时该落客厅');
assert.equal(handMemory.memoryNodes[0].importance, 8, 'csy 与手抓都是 1-10，不该换算');
assert.equal(handMemory.memoryNodes[0].embedded, true);
assert.equal(handMemory.memoryVectors.length, 1);
// Pro/ 是硅基的计费档前缀，手抓的 normalizeModelName 会剥掉，视为同一个 bge-m3
assert.equal(handMemory.memoryVectors[0].model, 'Pro/BAAI/bge-m3');
assert.equal(handMemory.memoryVectors[0].dimensions, vectorNumbers.length);
assert.deepEqual(plain(context.memoryVectorToNumbers(handMemory.memoryVectors[0].vector)), vectorNumbers,
  '手抓向量应存成 Float32 字节且无损');

// 不勾「保留向量」时只搬正文
const handTextOnly = context.toSullyBackup('sully-hand', 'sully-csy', csyWithMemory, { memory: true });
assert.equal(handTextOnly.memoryNodes.length, 1);
assert.equal(handTextOnly.memoryNodes[0].embedded, false, '不留向量时 embedded 必须是 false');
assert.equal(handTextOnly.memoryVectors, undefined);

// 手抓 → csy：升级方向缺 title，用正文前 6 字兜底
const csyBack = context.toSullyBackup('sully-csy', 'sully-hand', handMemory,
  { memory: true, keepVectors: true });
assert.equal(csyBack.vectorMemories.length, 1);
assert.equal(csyBack.vectorMemories[0].title, '用户不再喝奶', 'title 该取正文前 6 字');
assert.equal(csyBack.vectorMemories[0].source, 'import');
assert.deepEqual(plain(csyBack.vectorMemories[0].vector), vectorNumbers, 'csy 向量应还原成 number[]');

// csy → 330/兔k机：正文落 longTermMemory，同时补一份隐藏的 summary 消息给兔k机
const ephoneMemory = context.toEphoneCompatible('sully-csy', csyWithMemory,
  { memory: true, summaryMessages: true }).data;
const memChat = ephoneMemory.chats.find((chat) => chat.id === 'c1');
assert.equal(memChat.longTermMemory.length, 1, '330 从 longTermMemory 读记忆');
assert.equal(memChat.longTermMemory[0].content, '用户不再喝奶茶了');
const summaryMessages = memChat.history.filter((message) => message.type === 'summary');
assert.equal(summaryMessages.length, 1, '兔k机从 history 里的 summary 消息读记忆');
assert.equal(summaryMessages[0].isHidden, true, 'summary 消息必须隐藏，否则 330 会多出气泡');

// 重复转换不该让 summary 越滚越多
const twice = context.toEphoneCompatible('ephone',
  { version: 3, data: ephoneMemory }, { memory: true, summaryMessages: true }).data;
assert.equal(twice.chats.find((chat) => chat.id === 'c1').history
  .filter((message) => message.type === 'summary').length, 1, 'summary 消息重复叠加了');

// 兔k机 → csy：源里只有 summary 消息，没有 longTermMemory，也要能读出来
const rabbitStyle = {
  version: 3,
  data: {
    chats: [{
      id: 'c1', name: '阿糯', isGroup: false,
      history: [
        { id: 'm1', role: 'user', content: '你好', timestamp: 10 },
        { id: 's1', role: 'system', type: 'summary', content: '两人约好周末见面', timestamp: 11, isHidden: true },
      ],
    }],
  },
};
const rabbitToCsy = context.toSullyBackup('sully-csy', 'ephone', rabbitStyle, { memory: true });
assert.equal(rabbitToCsy.vectorMemories.length, 1, '兔k机的 summary 消息没被当成记忆读出来');
assert.equal(rabbitToCsy.vectorMemories[0].content, '两人约好周末见面');
assert.deepEqual(plain(rabbitToCsy.vectorMemories[0].vector), [], '没有向量时该留空数组');

// 330 → Float：importance 从 1-10 换算成 0-1，模型不同所以向量不搬
const memoryFloatBlob = await context.toFloatBackup('sully-csy', csyWithMemory,
  { memory: true, keepVectors: true });
const memoryFloatMap = context.zipEntryMap(await context.readZipEntries({
  name: 'float-memory.zip', arrayBuffer: () => memoryFloatBlob.arrayBuffer(),
}));
const memoryFloatManifest = JSON.parse(new TextDecoder().decode(memoryFloatMap.get('manifest.json')));
const memoryModule = memoryFloatManifest.modules.find((entry) => entry.id === 'memory');
assert.ok(memoryModule, 'Float 备份里没有 memory 模块');
assert.equal(memoryModule.records, 1);
const floatMemoryPayload = JSON.parse(
  new TextDecoder().decode(memoryFloatMap.get('modules/memory/000.json')));
const floatMemorySource = floatMemoryPayload.sources[0];
assert.equal(floatMemorySource.dbName, 'ai_phone_memory_db_v1');
assert.equal(floatMemorySource.stores[0].name, 'memories');
const floatRecords = floatMemorySource.stores[0].records;
assert.equal(floatRecords.length, 1);
assert.equal(floatRecords[0].value.content, '用户不再喝奶茶了');
assert.equal(floatRecords[0].value.type, 'long_term');
assert.match(floatRecords[0].value.characterId, /^char_/,
  '记忆的角色 ID 要换成 Float 新生成的 char_N，否则挂不到角色身上');
assert.ok(Math.abs(floatRecords[0].value.importance - 7 / 9) < 1e-9,
  'Float 的 importance 是 0-1，8 分该换算成 7/9');
assert.equal(floatRecords[0].value.embedding, undefined,
  'Float 用 text-embedding-3-small，和 bge-m3 的向量空间对不上，不该硬搬');

// 没勾记忆时不该出现 memory 模块
const plainFloatBlob = await context.toFloatBackup('sully-csy', csyWithMemory);
const plainFloatManifest = JSON.parse(new TextDecoder().decode(
  context.zipEntryMap(await context.readZipEntries({
    name: 'float-plain.zip', arrayBuffer: () => plainFloatBlob.arrayBuffer(),
  })).get('manifest.json')));
assert.equal(plainFloatManifest.modules.some((entry) => entry.id === 'memory'), false,
  '默认不转记忆，不该写 memory 模块');

// 糯叽机：容器是 data.structuredDB，外层没有 version:3，
// 读的时候不能走 sourceData（那个只在 version===3 时才下钻）
const nuojijiMemories = context.extractMemories('nuojiji', {
  data: {
    structuredDB: {
      memory: [{ id: 'nm1', characterId: 'c1', content: '记得带伞', timestamp: 1700000000000 }],
      summaryEntries: [{ id: 'ns1', characterId: 'c1', summary: '上周聊了旅行' }],
    },
  },
});
assert.equal(nuojijiMemories.length, 2, '糯叽机的 memory 和 summaryEntries 都该读出来');
assert.equal(nuojijiMemories[0].content, '记得带伞');

// 330 → 糯叽机：记忆摊平进 structuredDB.memory
const ephoneWithMemory = {
  version: 3,
  data: {
    chats: [{
      id: 'c1', name: '阿糯', isGroup: false, history: [],
      longTermMemory: [{ content: '用户怕黑', timestamp: 1700000000000 }],
    }],
  },
};
const nuojijiPlain = context.toNuojijiBackup('ephone', ephoneWithMemory);
assert.deepEqual(plain(nuojijiPlain.data.structuredDB.memory), [], '默认不转记忆');

const nuojijiWithMemory = context.toNuojijiBackup('ephone', ephoneWithMemory, { memory: true });
assert.equal(nuojijiWithMemory.data.structuredDB.memory.length, 1);
assert.equal(nuojijiWithMemory.data.structuredDB.memory[0].content, '用户怕黑');
assert.equal(nuojijiWithMemory.data.structuredDB.memory[0].characterId, 'c1');

// 没勾选项时，各家的记忆字段都不该冒出来
const handPlain = context.toSullyBackup('sully-hand', 'ephone', ephoneWithMemory);
assert.equal(handPlain.memoryNodes, undefined);
const csyPlain = context.toSullyBackup('sully-csy', 'ephone', ephoneWithMemory);
assert.equal(csyPlain.vectorMemories, undefined);

// ===== 表情包单独转换 =====
const stickerSource = {
  version: 3,
  data: {
    chats: [],
    userStickers: [
      { id: 's1', name: '开心', url: 'data:image/png;base64,AAA' },
      { id: 's2', name: '无图', url: '' },
    ],
  },
};
const pulled = context.extractStickers('ephone', stickerSource);
assert.equal(pulled.length, 1, '没有图片地址的条目该丢掉');
assert.equal(pulled[0].name, '开心', '名字必须原样保留：聊天记录是按名字引用表情的');

const stickerToHand = context.buildStickerOnlyBackup('sully-hand', pulled);
assert.equal(stickerToHand.version, 3);
assert.equal(stickerToHand.savedEmojis[0].name, '开心');
assert.equal(stickerToHand.savedEmojis[0].url, 'data:image/png;base64,AAA');
assert.equal(stickerToHand.characters, undefined, '只转表情的文件不该带角色表');

const stickerToWanwan = context.buildStickerOnlyBackup('wanwan', pulled);
assert.equal(stickerToWanwan.appName, '弯弯');
assert.equal(stickerToWanwan.stickers[0].image, 'data:image/png;base64,AAA');

const stickerToEphone = context.buildStickerOnlyBackup('ephone', pulled);
assert.equal(stickerToEphone.version, 3);
assert.equal(stickerToEphone.data.userStickers[0].name, '开心');

const stickerToOctopus = context.buildStickerOnlyBackup('octopus', pulled);
assert.equal(stickerToOctopus.myStickers[0].url, 'data:image/png;base64,AAA');

// Float 的表情是图集：名字在 KV 里，图片在主题素材库里靠 assetId 关联
const floatStickerSource = {
  kv: {
    ai_phone_sticker_packs_v1: [{
      id: 'pack1', name: '默认',
      stickers: [
        { id: 'fs1', name: '摸头', assetId: 'asset1' },
        { id: 'fs2', name: '外链', externalUrl: 'https://example.com/a.png' },
        { id: 'fs3', name: '断链', assetId: 'missing' },
      ],
    }],
  },
  idb: {
    ai_phone_theme_db_v1: {
      assets: [{ id: 'asset1', dataUrl: 'data:image/png;base64,BBB' }],
    },
  },
};
const floatStickers = context.extractStickers('float', floatStickerSource);
assert.equal(floatStickers.length, 2, '断链的表情该跳过');
assert.equal(floatStickers[0].url, 'data:image/png;base64,BBB', 'assetId 该查回素材库里的 dataUrl');
assert.equal(floatStickers[1].url, 'https://example.com/a.png', '外链表情该直接用 externalUrl');

// 糯叽机的表情分散在 stickers / stickerStore 两处
const nuojijiStickers = context.extractStickers('nuojiji', {
  data: {
    structuredDB: {
      stickers: [{ id: 'n1', name: '点赞', url: 'data:image/png;base64,CCC' }],
      stickerStore: [{ id: 'n2', name: '鼓掌', image: 'data:image/png;base64,DDD' }],
      kaomojis: [{ id: 'k1', name: '(・∀・)' }],
    },
  },
});
assert.equal(nuojijiStickers.length, 2, '颜文字没有图片，不该混进来');
assert.equal(nuojijiStickers[1].url, 'data:image/png;base64,DDD');

console.log('converter tests passed');

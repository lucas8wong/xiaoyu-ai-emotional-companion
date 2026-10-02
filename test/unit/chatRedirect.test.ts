import { test } from 'node:test';
import assert from 'node:assert';
import { detectChatRedirect, detectExplicitScene } from '../../api/services/chatRedirect.js';
import { CHAT_REDIRECT_GUIDE, pickChatRedirectGuide } from '../../api/services/prompts.js';

test('角色扮演指令分流：功能指令类 → roleplay（简/繁/英）', () => {
  const hit = [
    '我们来角色扮演吧',
    '来玩角色扮演',
    '进入角色扮演模式',
    '我想玩角色扮演',
    '我们来演剧情',
    '来一段剧情吧',
    '进入剧情模式',
    '开始剧情',
    '我想体验剧情演绎',
    '我们来演个故事',
    '我們來角色扮演吧',      // 繁体
    '進入劇情模式',          // 繁体
    'let\'s roleplay',
    'can you roleplay with me',
    'i want to play a story',
    'switch to story mode',
  ];
  for (const s of hit) assert.strictEqual(detectChatRedirect(s), 'roleplay', '应判定为 roleplay: ' + s);
});

test('角色扮演指令分流：角色代入请求 → chatCharacter（简/繁/英）', () => {
  const hit = [
    '你扮演我的男朋友',
    '你来演我的老师',
    '你演一下老师',
    '假装你是我的猫',
    '你能假装是我的男朋友吗',
    '从现在起你是我的私人医生',
    '我想让你扮演一位侦探',
    '给你个设定：你是江湖侠客',
    '把你的身份设定成一位管家',
    '你当我的猫咪好不好',
    '演一下我的女朋友',
    '假裝你是我的貓',        // 繁体
    'pretend to be my girlfriend',
    'can you act as my teacher',
    'i want you to be my cat',
  ];
  for (const s of hit) assert.strictEqual(detectChatRedirect(s), 'chatCharacter', '应判定为 chatCharacter: ' + s);
});

test('角色扮演指令分流：普通聊天 / 陈述句 / 评价不误伤', () => {
  const none = [
    '今天心情不错，谢谢你陪我',
    '我和同事关系有点僵，怎么办',
    '我在扮演一个好妈妈的角色，好累',      // 陈述自己的处境
    '你扮演得很像，演技真好',              // 评价 AI
    '我觉得他演的角色很有层次',            // 评论剧情
    '我想分享我的故事给你听',              // 「想…故事」但不是在要剧情
    '给我讲个睡前故事吧',                  // 聊天里的讲故事
    '我玩过剧情游戏，挺喜欢的',            // 过去式的体验
    '我想听你说说你的看法',
    'i had a long day at work today',
    'you are my best friend',
    'how was your day',
    '',
    '   ',
  ];
  for (const s of none) assert.strictEqual(detectChatRedirect(s), null, '不应分流: ' + s);
});

test('角色扮演指令分流：明确拒绝/不感兴趣时不打扰', () => {
  const none = [
    '我不想角色扮演，就想跟你说说话',
    '别演剧情了，我们说点真的',
    '我对角色扮演没兴趣',
    'i don\'t want to roleplay',
  ];
  for (const s of none) assert.strictEqual(detectChatRedirect(s), null, '拒绝语境不应分流: ' + s);
});

test('角色扮演指令分流：功能指令优先于角色代入', () => {
  assert.strictEqual(detectChatRedirect('我们来角色扮演吧，你扮演我的男朋友'), 'roleplay');
  assert.strictEqual(detectChatRedirect('进入剧情模式，你来当我的向导'), 'roleplay');
});

test('角色扮演指令分流：成人向请求 → adultRoleplay（简/繁/英）', () => {
  const hit = [
    '我们来聊点色情的',
    '来点涩涩的',
    '说点骚话给我听',
    '给我讲个黄段子',
    '尺度大一点',
    '尺度放开一点',
    '我们开黄腔吧',
    '我想聊 18禁 的内容',
    '来点涩涩的角色扮演',   // 带「角色扮演」但目的地多一步（开无限制模式）→ 归 adultRoleplay
    '說點葷話吧',           // 繁体
    'let\'s have sex',
    'can we talk dirty',
    'write me an erotic scene',
    'nsfw please',
    'i want you to sext me',
  ];
  for (const s of hit) assert.strictEqual(detectChatRedirect(s), 'adultRoleplay', '应判定为 adultRoleplay: ' + s);
});

test('角色扮演指令分流：成人向的误判防护（求助 / 拒绝 / 裸词都不算）', () => {
  const none = [
    // 这些都是「现实里的困扰」，把它们弹成"去开成人模式"是本类最贵的误判
    '我男朋友总让我聊色情的，我很难受',
    '对象让我说骚话，我不想但他一直逼我',
    '同事在饭桌上讲露骨的玩笑，我很不舒服',
    '有人拿我的裸照威胁我，我不知道该怎么办',
    '我和男朋友的性生活不太和谐，怎么开口',
    // 明确拒绝 / 不感兴趣
    '我讨厌色情的东西',
    '我不想聊色情的',
    '我对这种尺度没兴趣',
    // 同形词 / 陈述句
    '今天开荤吃火锅，太好吃了',
    '这部电影尺度很大，拍得很好',
    '他讲的这个黄段子其实挺老的',        // 「他讲」= 第三方主语 → 不算用户点单
    'i don\'t want to talk about sex',
    'my boyfriend wants me to send nudes',
  ];
  for (const s of none) assert.strictEqual(detectChatRedirect(s), null, '不应分流: ' + s);
});

test('角色扮演指令分流：成人向优先于普通角色扮演', () => {
  assert.strictEqual(detectChatRedirect('我们来角色扮演吧，说点骚话'), 'adultRoleplay');
  assert.strictEqual(detectChatRedirect('来一段剧情，尺度大一点'), 'adultRoleplay');
});

test('露骨戏判据（detectExplicitScene）：在写戏 → true；问病/求助/陈述 → false', () => {
  const yes = [
    '呜嗯雷淞然 你怎么又（缩在他怀里 忽然小腹被他火热挺硬的肉棒蹭到 浑身一颤 软着腰身嘤咛）这样难受吗（羞涩看着他）',
    '（他把我按在桌上 抽插着 我忍不住叫出声）',
    '（她的手指探进去 那处早已湿透 淫水顺着腿根往下淌）',
    '（他壓著我 抽插得又深又重 我整個人都軟了）',      // 繁体
  ];
  for (const s of yes) assert.strictEqual(detectExplicitScene(s), true, '应判为露骨戏: ' + s);

  const no = [
    // 问病 / 求助 / 现实困扰，把他们推去开成人模型是本判据最贵的错误
    '（我和男朋友做爱时很疼，是不是有问题？）',
    '（乳头疼了几天，是不是乳腺炎）',
    '（最近工作累，晚上疼得呻吟了一声）',
    '有人拿我的裸照威胁我，我不知道该怎么办',
    '我男朋友总让我聊色情的，我很难受',
    // 有露骨词但**没有**括号动作（在说事，不是在写戏）
    '他插进来的时候我好疼，该去看医生吗',
    // 有括号但括号里是问句
    '（我们能做爱吗？）',
    // 有括号、有情节，但没有无歧义性词
    '（羞的捂住脸 露出水润润的双眸 气氛暧昧火热）',
    '（他抱住我 我们是不是太快了）',
    '今天聊得很开心',
    '',
  ];
  for (const s of no) assert.strictEqual(detectExplicitScene(s), false, '不应判为露骨戏: ' + s);
});


test('角色扮演指令分流：引导语三语齐全且要点不丢', () => {
  for (const lang of ['zh-CN', 'zh-TW', 'en'] as const) {
    const rp = CHAT_REDIRECT_GUIDE[lang].roleplay;
    const cc = CHAT_REDIRECT_GUIDE[lang].chatCharacter;
    assert.ok(rp.length > 40, lang + ' roleplay 文案过短');
    assert.ok(cc.length > 40, lang + ' chatCharacter 文案过短');
  }
  // 简体：指路「剧情演绎」+ 提到可自己创建剧本
  assert.match(CHAT_REDIRECT_GUIDE['zh-CN'].roleplay, /剧情演绎/);
  assert.match(CHAT_REDIRECT_GUIDE['zh-CN'].roleplay, /自己创建剧本/);
  assert.match(CHAT_REDIRECT_GUIDE['zh-CN'].chatCharacter, /新建角色/);
  // 繁体：文案为繁体（含繁体字），并指路「劇情演繹」
  assert.match(CHAT_REDIRECT_GUIDE['zh-TW'].roleplay, /劇情演繹/);
  assert.match(CHAT_REDIRECT_GUIDE['zh-TW'].chatCharacter, /新增角色/);
  assert.doesNotMatch(CHAT_REDIRECT_GUIDE['zh-TW'].roleplay, /剧情演绎/);
  // 英文
  assert.match(CHAT_REDIRECT_GUIDE['en'].roleplay, /Roleplay/);
  assert.match(CHAT_REDIRECT_GUIDE['en'].chatCharacter, /New character/);
  // 取文案：lang 归一（zh → zh-CN）
  assert.strictEqual(pickChatRedirectGuide('zh', 'roleplay'), CHAT_REDIRECT_GUIDE['zh-CN'].roleplay);
  assert.strictEqual(pickChatRedirectGuide('zh-TW', 'chatCharacter'), CHAT_REDIRECT_GUIDE['zh-TW'].chatCharacter);
  assert.strictEqual(pickChatRedirectGuide('en', 'roleplay'), CHAT_REDIRECT_GUIDE['en'].roleplay);
});

test('角色扮演指令分流：成人向引导语必须「指路 + 说清开关位置」，且不许出现冷拒口径', () => {
  for (const lang of ['zh-CN', 'zh-TW', 'en'] as const) {
    const ad = CHAT_REDIRECT_GUIDE[lang].adultRoleplay;
    assert.ok(ad.length > 60, lang + ' adultRoleplay 文案过短');
    // 用户明确要求：不能是「打住，这里不能聊这个」这类回答
    assert.doesNotMatch(ad, /打住|不能聊|没法聊|不能继续|换个话题/, lang + ' 出现了冷拒口径');
  }
  // 三语都必须点到「无限制模式」这个开关（只丢功能名 = 用户进去还是找不到，等于没解决）
  assert.match(CHAT_REDIRECT_GUIDE['zh-CN'].adultRoleplay, /无限制模式/);
  assert.match(CHAT_REDIRECT_GUIDE['zh-CN'].adultRoleplay, /剧情演绎/);
  assert.match(CHAT_REDIRECT_GUIDE['zh-CN'].adultRoleplay, /18 岁/);
  assert.match(CHAT_REDIRECT_GUIDE['zh-TW'].adultRoleplay, /無限制模式/);
  assert.match(CHAT_REDIRECT_GUIDE['zh-TW'].adultRoleplay, /劇情演繹/);
  assert.doesNotMatch(CHAT_REDIRECT_GUIDE['zh-TW'].adultRoleplay, /剧情演绎/);
  assert.match(CHAT_REDIRECT_GUIDE['en'].adultRoleplay, /Unlimited mode/);
  assert.match(CHAT_REDIRECT_GUIDE['en'].adultRoleplay, /18\+/);
  assert.strictEqual(pickChatRedirectGuide('zh', 'adultRoleplay'), CHAT_REDIRECT_GUIDE['zh-CN'].adultRoleplay);
});

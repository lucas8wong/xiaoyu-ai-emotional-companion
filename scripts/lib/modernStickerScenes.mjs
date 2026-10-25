export const modernStickerScenes = [
 ['greeting','问候与报到','問候與報到','你好 嗨 早安 到了 回来啦 回來啦 hello'],
 ['ack','收到与赞同','收到與贊同','收到 好的 点赞 贊同 可以 ok'],
 ['confused','疑惑与震惊','疑惑與震驚','疑惑 啥 震惊 震驚 问号 問號 what'],
 ['laugh','开心与大笑','開心與大笑','开心 開心 哈哈 笑死 耶 happy laugh'],
 ['tease','调侃与斗嘴','調侃與鬥嘴','吐槽 调侃 調侃 斗嘴 鬥嘴 嘴硬 哼'],
 ['speechless','无语与叹气','無語與嘆氣','无语 無語 没招了 沒招了 叹气 嘆氣 无奈 無奈'],
 ['work','工作学习与下班','工作學習與下班','工作 上班 下班 加班 学习 學習 读书 讀書'],
 ['rest','困倦休息与晚安','困倦休息與晚安','好困 累了 晚安 休息 睡觉 睡覺 躺平 sleep'],
 ['food','吃饭喝水与零食','吃飯喝水與零食','吃饭 吃飯 饿了 餓了 喝水 咖啡 零食 food'],
 ['care','安慰与陪伴','安慰與陪伴','安慰 陪伴 摸摸 辛苦了 没事 沒事 comfort'],
 ['sad','委屈与求安慰','委屈與求安慰','委屈 难过 難過 哭哭 失落 sad'],
 ['miss','想念与等待','想念與等待','想你 等你 等待 在吗 在嗎 miss'],
 ['hug','抱抱与贴贴','抱抱與貼貼','抱抱 贴贴 貼貼 蹭蹭 黏人 hug cuddle'],
 ['kiss','亲亲与心动','親親與心動','亲亲 親親 心动 心動 比心 喜欢 喜歡 kiss love'],
 ['flirt','撒娇与暧昧','撒嬌與曖昧','撒娇 撒嬌 暧昧 曖昧 害羞 脸红 臉紅'],
 ['jealous','吃醋与闹脾气','吃醋與鬧脾氣','吃醋 闹脾气 鬧脾氣 不理你 哼 jealous'],
 ['reconcile','哄人与和好','哄人與和好','哄人 和好 对不起 對不起 抱歉 不气 不氣 sorry'],
 ['abstract','抽象与一本正经整活','抽象與一本正經整活','抽象 整活 搞笑 高雅 发疯 發瘋 meme'],
 ['observe','围观与细品','圍觀與細品','围观 圍觀 吃瓜 观察 觀察 细品 細品 盯'],
 ['refusal','拒绝与摇头','拒絕與搖頭','不要 不行 拒绝 拒絕 摇头 搖頭 no'],
 ['play','游戏与玩耍','遊戲與玩耍','游戏 遊戲 开黑 開黑 玩耍 娱乐 娛樂 game'],
 ['music','听歌与跳舞','聽歌與跳舞','音乐 音樂 听歌 聽歌 跳舞 唱歌 music dance'],
 ['sport','运动与出游','運動與出遊','运动 運動 健身 出游 出遊 旅行 散步 sport travel'],
 ['weather','天气与季节','天氣與季節','天气 天氣 下雨 好冷 冬天 保暖 雪 weather'],
 ['home','居家与小日常','居家與小日常','居家 日常 打扫 打掃 刷牙 生活 home'],
 ['shopping','购物与小愿望','購物與小願望','购物 購物 买买买 買買買 礼物 禮物 shopping'],
 ['celebrate','庆祝与节日','慶祝與節日','庆祝 慶祝 恭喜 生日 节日 節日 圣诞 聖誕 celebrate'],
].map(([id,zh,zhHant,words])=>({id,zh,zhHant,keywords:words.split(' ')}));

const mapping={};
function entries(family,items){for(const [order,title,...scenes]of items)mapping[`${family}-${order}`]={title,scenes};}
entries('A',[
 [1,'乖乖看着你','flirt','observe'],[2,'委屈猫猫','sad'],[3,'猫猫无语','speechless'],[4,'忍住不说话','speechless','tease'],[5,'猫猫震惊','confused'],[6,'猫猫抬头看','observe','confused'],[7,'快乐扭一扭','laugh','play'],[8,'不好意思低下头','flirt'],[9,'若有所思的猫','observe','confused'],[10,'猫猫暴躁一下','tease','jealous'],[11,'看起来淡定，其实是没招了','speechless','work'],[12,'小猫扔番茄','tease','abstract'],
]);
entries('E',[
 [1,'小金毛开心蹦蹦','laugh','flirt'],[2,'小白爱的充电','kiss','flirt'],[3,'下班一起跑回家','work','greeting'],[4,'给你点个赞','ack'],[5,'爱心发射','kiss'],[6,'小狗扑过来','hug','greeting'],[7,'一起吃饭','food'],[8,'开心跳舞','music','laugh'],[9,'听歌摇摆','music'],[10,'小狗乖乖等','miss','flirt'],[11,'趴在你头上睡觉','rest','hug'],[12,'小狗困困','rest'],[13,'小狗趴平了','rest'],[14,'两只小狗亲亲','kiss','hug'],[15,'小狗刚睡醒','rest','greeting'],[16,'抱抱贴贴','hug'],[17,'靠在一起陪伴','care','hug'],[18,'害羞托脸','flirt'],
]);
entries('F',[
 [1,'喝口奶甜一下','food','flirt'],[2,'哭哭吃饭','sad','food'],[3,'盖好小被子','rest','care'],[4,'拿着手机找你','miss'],[5,'开心晃一晃','laugh'],[6,'装乖的小猫','flirt'],[7,'灰猫转头看你','observe','tease'],[8,'抱着你','hug'],[9,'把爱心给你','kiss'],[10,'两只猫猫吃冰淇淋','food','hug'],[11,'灰猫吃冰淇淋','food'],[12,'白猫吃冰淇淋','food'],[13,'趴在你身上','hug','rest'],[14,'一起吃西瓜','food'],[15,'围同一条围巾','hug','weather'],[16,'陪你睡觉','rest','care'],[17,'一起来点零食','food','hug'],[18,'钻进同一个被窝','rest','hug'],[19,'背着你走','hug','play'],[20,'给你一个大拥抱','hug'],[21,'爱心被窝贴贴','rest','hug'],[22,'飞吻给你','kiss'],[23,'轻轻抱住你','hug','care'],[24,'摸摸脑袋','care','hug'],[25,'背着小猫玩','play','hug'],[26,'偷偷亲一下','kiss'],[27,'送你一篮子爱心','kiss','shopping'],[28,'黏着不撒手','hug','miss'],
]);
entries('G',[
 [1,'小熊穿猫猫帽','flirt','home'],[2,'小熊顶着小鸭子','laugh','home'],[3,'棕熊帽帽','flirt'],[4,'熊猫帽帽','flirt'],[5,'奶牛装卖萌','flirt'],[6,'转身哼一声','jealous','tease'],[7,'小熊抱枕头','rest','miss'],[8,'诶嘿一下','laugh','tease'],[9,'一起看着你','observe'],[10,'偷偷亲一口','kiss'],[11,'抱住不放','hug'],[12,'背背抱抱','hug'],[13,'一起补个觉','rest','hug'],[14,'晚安碎觉啦','rest'],[15,'热爱工作的小熊','work','tease'],[16,'靠着你睡着了','rest','care'],[17,'我知错了','reconcile','sad'],[18,'害羞搓搓手','flirt'],[19,'我真的是大笨了','sad','speechless'],[20,'抱着枕头闹一下','tease','play'],[21,'轻轻闹你一下','tease','play'],[22,'情侣玩闹','tease','play'],[23,'开启本周幸运','celebrate','work'],[24,'叼着玫瑰来找你','kiss','flirt'],[25,'不气不气','reconcile','care'],[26,'不对不对','refusal','confused'],[27,'笑趴了','laugh'],[28,'拜托拜托','flirt','miss'],[29,'嗯嗯收到','ack'],[30,'躲在墙后偷看','observe','flirt'],
]);
entries('H',[
 [1,'无聊得坐不住','miss','rest'],[2,'为啥不理我','miss','jealous'],[3,'困得瘫倒了','rest'],[4,'噜噜跳个舞','music','laugh'],[5,'开心蹦蹦','laugh'],[6,'怼脸看看你','observe','confused'],[7,'噜噜转头','observe'],[8,'下课咯','work','laugh'],[9,'噜噜抬头望望','observe'],[10,'背着手溜达','sport','greeting'],[11,'噜噜起飞','abstract','laugh'],[12,'唱给你听','music'],[13,'靠着枕头睡觉','rest'],[14,'自带高光的噜噜','laugh','abstract'],[15,'噜噜委屈巴巴','sad'],[16,'一起拍个照','hug','home'],[17,'举杯喝水','food'],[18,'噜噜走来了','greeting'],
]);

// Chosen directly from the reviewed contact sheets. Unselected near-duplicate
// props/weapon templates remain in the private download cache, outside the bundle.
entries('D',[
 [1,'高雅人士就位','abstract','greeting'],[2,'高雅人士宣布','greeting','abstract'],[3,'高雅驯鹿','celebrate'],[4,'高雅摄影','observe'],[5,'高雅路过','greeting'],[7,'高雅记录','work'],[9,'高雅举牌','abstract'],[10,'高雅发言','music'],[11,'高雅观察','observe'],[12,'高雅冲浪','sport'],[13,'高雅钓鱼','rest'],[14,'高雅健身','sport'],[15,'高雅指一指','abstract'],[16,'高雅举重','sport'],[17,'高雅过冬','weather'],[18,'高雅摊手','confused'],[19,'高雅开饭','food'],[20,'高雅拍板','ack'],[22,'高雅送礼','celebrate','shopping'],[23,'高雅掌舵','sport'],[25,'高雅度假','sport'],[33,'高雅躺平','rest'],[36,'高雅浇花','home'],[41,'高雅打球','sport'],[42,'高雅喝一口','food'],[43,'高雅打扫','home'],[46,'高雅保暖','weather'],[47,'高雅入场','play'],[48,'高雅联系','miss'],[49,'高雅听歌','music'],[50,'高雅潜伏','abstract'],[51,'高雅艾特','ack'],[54,'高雅滑雪','sport','weather'],[55,'高雅采购','shopping'],[58,'高雅雪橇','sport','weather'],[59,'高雅修一修','work'],[60,'高雅结伴','sport'],[61,'高雅选方向','confused'],[62,'高雅广播','greeting'],[64,'高雅吃苹果','food'],[65,'高雅疑问','confused'],[66,'高雅拒绝','refusal'],[67,'高雅看手机','miss'],[68,'高雅足球','sport'],[70,'高雅穿搭','abstract'],[73,'高雅讲解','work'],[74,'高雅发现宝藏','shopping'],[75,'高雅玩雪','play','weather'],[76,'高雅阅读','work'],[77,'高雅咖啡','food'],[78,'高雅高尔夫','sport'],[79,'高雅看报','work'],[80,'高雅记笔记','work'],[81,'高雅打工','work'],[82,'高雅拿奖','celebrate'],[83,'高雅逛街','shopping'],[84,'高雅蹦蹦','laugh'],[85,'高雅出发','sport'],[86,'高雅比心','kiss'],[89,'高雅小声宣布','greeting'],[91,'高雅数钱','shopping'],[92,'高雅出场','abstract'],[94,'高雅刷牙','home'],[95,'高雅去游泳','sport'],[96,'高雅潜水','sport'],[98,'高雅来信','greeting'],[100,'高雅冲个浪','sport'],[118,'高雅耳机上线','music','greeting'],[119,'高雅细品','observe'],[124,'高雅解答','confused'],[126,'高雅开会','work'],[130,'高雅集体蹦蹦','play'],[133,'高雅画画','home'],[134,'高雅弹吉他','music'],[135,'高雅毕业','celebrate','work'],[139,'高雅送花','kiss'],[141,'高雅赏花','home'],[150,'高雅等时间','miss'],[153,'高雅爱心气球','kiss'],[155,'高雅收信','greeting'],[156,'高雅加班','work'],[164,'高雅逗你笑','laugh','abstract'],[172,'高雅打电话','miss'],[180,'高雅调色','home'],[193,'高雅看电影','play'],[199,'高雅翻车了','speechless','tease'],[201,'高雅打网球','sport'],[204,'高雅认真看书','work'],[217,'高雅算一算','work'],[220,'高雅奏乐','music'],[227,'高雅练拳','sport'],[239,'高雅一朵玫瑰','kiss'],[243,'高雅打游戏','play'],[272,'高雅施法','abstract'],[286,'高雅恭喜','celebrate'],[302,'高雅拼拼图','play'],[320,'高雅点赞','ack'],[329,'高雅同意','ack'],[332,'高雅撑伞视察','weather','observe'],[371,'高雅圣诞','celebrate'],[383,'高雅摇铃','celebrate'],
]);

const excluded=new Set(['C-23','I-4','I-49','I-58','I-70','I-127','I-145']);
export function classifyModernSticker(a){
 const key=`${a.family}-${a.order}`;
 if(excluded.has(key)||a.family==='D'&&!mapping[key])return null;
 if(mapping[key])return mapping[key];
 if(a.family==='C'){
  const title=a.order===1?'等心肝':a.title.replace(/^负鼠\d+-/,'');
  const scene=/爱河|约会/.test(title)?'flirt':/等|已读/.test(title)?'miss':/工作|老板|周一|方案|饼|转正|事业/.test(title)?'work':/音乐/.test(title)?'music':/深度思考|细品/.test(title)?'observe':/人生|看开|i-am-fine/.test(title)?'speechless':'tease';
  return {title,scenes:[scene,'abstract']};
 }
 if(a.family==='I'){
  const groups={
   laugh:[2,25,27,37,39,40,41,45,57,63,72,78,79,81,84,91,101,102,104,108,120,123,139],
   rest:[1,5,17,33,53,61,64,86,87,111,115,118,129,130,132],
   food:[12,62,126,135,141],
   shopping:[14,69],sport:[3,7,8,18,19,22,23,30,31,46,54,59,73,74,76,82,95],
   music:[10,16,26,28,43,67,68,96],flirt:[9,11,13,75,83,90],
   confused:[6,24,29,42,48,52,60,65,89,98,100,107,119,134],
   observe:[15,51,55,56,71,80,85,97,105,128,131,133,140],
   ack:[44,92,94,103,113,122,125,142,143],
   care:[66,110,112,136],speechless:[21,35,77,88,93,99,106,109,116,117,121,124,137,138],
   greeting:[20,32,34,38,47,50,144],
  };
  const found=Object.entries(groups).find(([,orders])=>orders.includes(a.order))?.[0]||'abstract';
  const label=modernStickerScenes.find(s=>s.id===found)?.zh||'抽象反应';
  return {title:`奶龙${label} ${a.order}`,scenes:[found,'abstract']};
 }
 throw Error(`Missing visual classification: ${key}`);
}

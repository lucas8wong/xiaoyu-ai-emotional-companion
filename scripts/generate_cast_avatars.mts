#!/usr/bin/env node
/**
 * 多角色剧本「配角头像」生成器（2026-10-01）
 *
 * 复用 `api/services/imageApi.ts` 的现用后端（默认走**本机免费侧车**：.venv-image + SDXL，
 * 见 README/CHANGELOG 里那套用法），尺寸与现有 30 张主角头像对齐：**768×1024（3:4）JPG**。
 *
 * 用法：
 *   node/npx tsx scripts/generate_cast_avatars.mts --dry-run
 *   npx tsx scripts/generate_cast_avatars.mts --provider sidecar --only <key> --only <key> ...
 *   npx tsx scripts/generate_cast_avatars.mts --provider sidecar --variants 3 --outdir temp/xxx
 *
 * 风格：**分两组锚点**（按剧本题材选，不写死一套）
 *   ancient = 中国古风（红帷幔/格窗/暖烛光），modern = 现代都市·校园·刑侦（虚化实景 + 电影感打光）。
 *   两组都保持「半写实插画/漫画感 + 干净线稿」，与现有 30 张主角头像同一族。
 *
 * 🔴 红线（与场景配图一致）：prompt 只来自本文件的白名单表（作者手写），用户文本永不进 prompt。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import dotenv from 'dotenv';
import { generateImage, resolveProviderId, providerReady, providerModel, priceOfProvider, stableSeed } from '../api/services/imageApi.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });
dotenv.config({ path: path.join(ROOT, '.env.local'), quiet: true, override: true });

const W_DEFAULT = 768, H_DEFAULT = 1024;

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const valOf = (flag: string, dflt: string): string => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt; };
const only: string[] = [];
for (let i = 0; i < args.length; i++) if (args[i] === '--only' && args[i + 1]) only.push(args[++i]);
const providerArg = valOf('--provider', '');
const variants = Math.max(1, Number(valOf('--variants', '1')) || 1);
const outDir = path.resolve(ROOT, valOf('--outdir', 'public/img/roleplay'));
const W = Number(valOf('--width', '0')) || W_DEFAULT;
const H = Number(valOf('--height', '0')) || H_DEFAULT;

/** 风格锚点：按剧本题材选一组（现代 / 古风）。改这里等于换整批画风，改前先看对应题材的主角头像。 */
const STYLES = {
  modern: {
    en: 'semi-realistic anime illustration, manhwa style, clean line art, cel shading, cinematic lighting, modern Chinese setting, softly blurred background, bust portrait, facing viewer',
    zh: '半写实动漫插画，漫画感干净线稿，赛璐璐上色，电影感打光，现代中国场景，背景虚化，半身肖像，正面',
    negative: 'photorealistic, realistic, photograph, 3d render, detailed skin pores, oil painting, text, letters, calligraphy, signature, seal, stamp, watermark, logo, multiple people, landscape, full body, wide shot, deformed hands, chibi, ancient chinese costume, hanfu, period drama clothing, white lab coat',
  },
  ancient: {
    en: 'semi-realistic Chinese illustration, guofeng character art, clean line art, soft light color wash, ancient Chinese interior, red silk curtain, wooden lattice window, warm candlelight, close-up bust portrait, head and shoulders, face fills the frame, facing viewer',
    zh: '半写实国风插画，干净线稿，淡彩渲染，古代中式内景，红色帷幔，木格窗，暖黄烛光，特写半身肖像，头肩构图，面部充满画面，正面',
    // 古风锚点最容易出「全身 + 大场景」：脸在头像尺寸下只剩几个像素，所以负面把全身/远景/家具全钉死
    negative: 'photorealistic, realistic, photograph, 3d render, detailed skin pores, oil painting, watercolor, text, letters, calligraphy, signature, seal, stamp, watermark, logo, multiple people, two people, group, landscape, full body, full-length figure, wide shot, distant figure, small face, tiny face, room interior, furniture, kimono, japanese, deformed hands, chibi',
  },
} as const;
type StyleKey = keyof typeof STYLES;

interface Row { key: string; file: string; style: StyleKey; promptEn: string; promptZh: string }

/** 白名单：新增配角就在这里加一行（key/file 用 `<scenarioId>-<castId>`） */
const ROWS: Row[] = [
  // 【1 他等了我十五年（现代·港圈年上）】
  { key: 'guyushen-songzhi-chenbo', file: 'guyushen-songzhi-chenbo.jpg', style: 'modern',
    promptEn: 'elderly Chinese chauffeur, late sixties, short grey hair, weathered kind face, dark driver suit and peaked cap, standing beside a black car at night',
    promptZh: '六十多岁的中国老司机，花白短发，饱经风霜的温和面孔，深色司机制服与制帽，夜里站在黑色轿车旁' },
  { key: 'guyushen-songzhi-shenjia', file: 'guyushen-songzhi-shenjia.jpg', style: 'modern',
    promptEn: 'young Chinese businessman rival, early thirties, slicked-back hair, arrogant half-smile, sharp black suit, luxury hotel lounge',
    promptZh: '三十出头的中国年轻商人，对手角色，背头，傲慢的浅笑，挺括黑西装，豪华酒店酒廊' },
  { key: 'guyushen-songzhi-amay', file: 'guyushen-songzhi-amay.jpg', style: 'modern',
    promptEn: 'young Hong Kong woman in her twenties, wavy shoulder-length hair, denim jacket, playful knowing smile, neon night street',
    promptZh: '二十多岁的香港女孩，齐肩卷发，牛仔外套，俏皮会意的笑，霓虹夜市街头' },
  { key: 'peixiuyuan-linwantang-linwanling', file: 'peixiuyuan-linwantang-linwanling.jpg', style: 'ancient',
    promptEn: 'young Chinese noblewoman, nineteen, elegant updo with a jade hairpin, dark red and pale gold Ming dynasty hanfu with crossed collar, composed resolute gaze, front view, bust portrait, red silk curtain background',
    promptZh: '十九岁的中国名门闺秀，优雅盘发插玉簪，深红配浅金的明代交领汉服，沉静而决绝的目光，正面，半身肖像，红色帷幔背景' },
  // 【3 贵族高中的坏狗（现代·私立高中）】
  { key: 'luyan-sunian-zhousong', file: 'luyan-sunian-zhousong.jpg', style: 'modern',
    promptEn: 'Chinese high school boy, seventeen, short messy brown hair, sporty school jacket, wide teasing grin, school gym in background',
    promptZh: '十七岁中国高中男生，乱蓬蓬的棕短发，运动款校服外套，咧嘴逗趣的笑，背景是学校体育馆' },
  { key: 'luyan-sunian-luwei', file: 'luyan-sunian-luwei.jpg', style: 'modern',
    promptEn: 'Chinese high school girl, fifteen, twin ponytails, navy school uniform, curious bright eyes, sunny campus corridor',
    promptZh: '十五岁中国高中女生，双马尾，藏青色校服，好奇明亮的眼睛，阳光下的校园走廊' },
  { key: 'luyan-sunian-bailu', file: 'luyan-sunian-bailu.jpg', style: 'modern',
    promptEn: 'Chinese high school girl, seventeen, neat long black hair, thin glasses, school uniform with a press badge, calm confident',
    promptZh: '十七岁中国高中女生，整齐黑长发，细框眼镜，校服上别着校刊记者证，冷静自信' },
  // 【4 草原上的和亲公主（古代·草原）】
  { key: 'tuobaye-shenlianxing-bayin', file: 'tuobaye-shenlianxing-bayin.jpg', style: 'ancient',
    promptEn: 'old steppe healer man, sixties, deeply wrinkled face, grey braid, fur-trimmed robe, leather medicine pouch',
    promptZh: '六十多岁的草原老医官，满面深皱纹，灰白辫发，镶毛皮长袍，皮制药囊' },
  { key: 'tuobaye-shenlianxing-ashina', file: 'tuobaye-shenlianxing-ashina.jpg', style: 'ancient',
    promptEn: 'mature steppe noblewoman, forties, ornate jewelled headdress, fur-collared robe, commanding cold gaze',
    promptZh: '四十多岁的草原贵妇，华丽嵌宝头饰，毛领长袍，威严冷峻的目光' },
  { key: 'tuobaye-shenlianxing-yugu', file: 'tuobaye-shenlianxing-yugu.jpg', style: 'ancient',
    promptEn: 'middle-aged Chinese matron, fifties, plain hanfu, hair in a tight bun, worried protective expression',
    promptZh: '五十多岁的中国妇人，素色汉服，头发梳紧成髻，担忧而护主的神情' },
  // 【5 黏人的毕业学长（现代·校园）】
  { key: 'jiangyubai-wenruanruan-chenxu', file: 'jiangyubai-wenruanruan-chenxu.jpg', style: 'modern',
    promptEn: 'young Chinese man, mid twenties, round glasses, grey hoodie, cheerful grin, startup office with monitors',
    promptZh: '二十多岁的中国年轻男人，圆框眼镜，灰色卫衣，开朗的笑，创业办公室里显示器成排' },
  { key: 'jiangyubai-wenruanruan-sunian', file: 'jiangyubai-wenruanruan-sunian.jpg', style: 'modern',
    promptEn: 'Chinese high school girl, sixteen, short bob hair, school uniform, gossipy grin, classroom window light',
    promptZh: '十六岁中国高中女生，齐耳短发，校服，八卦起的笑，教室窗边光线' },
  { key: 'jiangyubai-wenruanruan-nianji', file: 'jiangyubai-wenruanruan-nianji.jpg', style: 'modern',
    promptEn: 'middle-aged Chinese male teacher, fifties, square glasses, stern face, shirt and tie, school office',
    promptZh: '五十多岁的中国男教师，方框眼镜，神情严厉，衬衫领带，学校办公室' },
  // 【6 疯批总裁的白月光（现代·都市）】
  { key: 'luwang-guxiaoman-zhouyan', file: 'luwang-guxiaoman-zhouyan.jpg', style: 'modern',
    promptEn: 'young Chinese male secretary, thirties, slim build, black suit, expressionless, glass-walled office at night',
    promptZh: '三十岁出头的中国男秘书，瘦削，黑西装，面无表情，夜里玻璃幕墙办公室' },
  { key: 'luwang-guxiaoman-laodao', file: 'luwang-guxiaoman-laodao.jpg', style: 'modern',
    promptEn: 'rough heavy-set Chinese man, late forties, shaved head, scar through one eyebrow, stubble, worn black leather jacket, rainy alley at night',
    promptZh: '四十多岁粗壮的中国男人，光头，眉上一道疤，胡茬，磨旧的黑色皮夹克，雨夜巷子' },
  { key: 'luwang-guxiaoman-luchen', file: 'luwang-guxiaoman-luchen.jpg', style: 'modern',
    promptEn: 'mature Chinese businessman, fifties, silver temples, expensive grey suit, cold smile, old family mansion',
    promptZh: '五十多岁的成熟中国商人，鬓角银白，昂贵灰西装，冷笑，老宅厅堂' },
  // 【7 高冷女总裁的落魄助理（现代·职场）】
  { key: 'shenqingyi-luchi-gumingchuan', file: 'shenqingyi-luchi-gumingchuan.jpg', style: 'modern',
    promptEn: 'Chinese corporate vice president, forties, side-parted hair, grey suit, calculating look, boardroom',
    promptZh: '四十多岁的中国企业副总，侧分头发，灰西装，算计的眼神，会议室' },
  { key: 'shenqingyi-luchi-suhe', file: 'shenqingyi-luchi-suhe.jpg', style: 'modern',
    promptEn: 'young Chinese female secretary, mid twenties, ponytail, white blouse and pencil skirt, tablet in hand, office',
    promptZh: '二十多岁的中国女秘书，马尾，白衬衫与铅笔裙，手里拿着平板，办公室' },
  { key: 'shenqingyi-luchi-qianjingli', file: 'shenqingyi-luchi-qianjingli.jpg', style: 'modern',
    promptEn: 'Chinese middle-aged man, forties, cheap wrinkled suit, sweaty forehead, nervous yet aggressive, office lobby',
    promptZh: '四十多岁的中国中年男人，皱巴巴的廉价西装，额头冒汗，又急又凶，公司大堂' },
  // 【8 温柔女医生（现代·医院）】
  { key: 'linjianwei-chenyi-wangjie', file: 'linjianwei-chenyi-wangjie.jpg', style: 'modern',
    promptEn: 'Chinese head nurse, mid forties, short hair, blue scrubs, capable kind face, hospital corridor',
    promptZh: '四十多岁的中国护士长，短发，蓝色洗手服，干练而和善的面孔，医院走廊' },
  { key: 'linjianwei-chenyi-zhouming', file: 'linjianwei-chenyi-zhouming.jpg', style: 'modern',
    promptEn: 'Chinese male doctor, mid thirties, white coat, stethoscope, gentle smile, ward station',
    promptZh: '三十多岁的中国男医生，白大褂，听诊器，温和的笑，护士站' },
  { key: 'linjianwei-chenyi-xiaoyu', file: 'linjianwei-chenyi-xiaoyu.jpg', style: 'modern',
    promptEn: 'Chinese teenage boy patient, sixteen, hospital gown, pale and bored, sitting up in a ward bed',
    promptZh: '十六岁的中国少年病人，病号服，脸色偏白有点无聊，坐在病床上' },
  // 【9 傲娇大小姐（现代·豪门）】
  { key: 'guwanqing-heyu-laozhou', file: 'guwanqing-heyu-laozhou.jpg', style: 'modern',
    promptEn: 'elderly Chinese butler, sixties, neat grey hair, black tailcoat and white gloves, dignified, grand hallway',
    promptZh: '六十多岁的中国老管家，整齐灰发，黑燕尾服与白手套，庄重，宅邸长廊' },
  { key: 'guwanqing-heyu-guwanning', file: 'guwanqing-heyu-guwanning.jpg', style: 'modern',
    promptEn: 'elegant Chinese young woman, late twenties, updo, silk dress, condescending smile, family banquet hall',
    promptZh: '二十八九岁的优雅中国女人，盘发，丝绸礼服，居高临下的笑，家宴厅' },
  { key: 'guwanqing-heyu-awu', file: 'guwanqing-heyu-awu.jpg', style: 'modern',
    promptEn: 'Chinese male bodyguard, thirties, buzz cut, black suit, earpiece, serious, luxury car park',
    promptZh: '三十多岁的中国男保镖，寸头，黑西装，耳麦，严肃，豪车停车场' },
  // 【10 冷峻刑警的年下法医（现代·刑侦）】
  { key: 'lutingyuan-shenyan-laoxing', file: 'lutingyuan-shenyan-laoxing.jpg', style: 'modern',
    promptEn: 'Chinese male detective, mid forties, stubble, worn leather jacket, tired sharp eyes, police station',
    promptZh: '四十多岁的中国男刑警，胡茬，旧皮夹克，疲惫而锐利的眼睛，警局' },
  { key: 'lutingyuan-shenyan-dengjiaoshou', file: 'lutingyuan-shenyan-dengjiaoshou.jpg', style: 'modern',
    promptEn: 'Chinese forensic professor, mid fifties, thin glasses, white lab coat, calm authority, autopsy room doorway',
    promptZh: '五十多岁的中国法医教授，细框眼镜，白大褂，沉静有威信，解剖室门口' },
  { key: 'lutingyuan-shenyan-gaoyuan', file: 'lutingyuan-shenyan-gaoyuan.jpg', style: 'modern',
    promptEn: 'Chinese man, mid thirties, gaunt hollow cheeks, cold defiant stare, dark grey wrinkled jacket over black shirt (no white coat), bare interrogation room',
    promptZh: '三十多岁的中国男人，面颊凹陷，冷而倔强的注视，深灰皱夹克内搭黑衬衫（不是白大褂），空荡审讯室' },

  // ═══ 第二批 #11–#20 ═══
  // 11 飒爽女律师的温柔记者（现代·律政）
  { key: 'suwanzhou-wenyan-zhengming', file: 'suwanzhou-wenyan-zhengming.jpg', style: 'modern',
    promptEn: 'Chinese law firm partner, fifties, silver-streaked hair, tailored dark suit, calm authoritative, wood-panelled office',
    promptZh: '五十多岁的中国律所合伙人，鬓有银丝，考究深色西装，沉稳有威严，木质办公室' },
  { key: 'suwanzhou-wenyan-yetang', file: 'suwanzhou-wenyan-yetang.jpg', style: 'modern',
    promptEn: 'young Chinese female law intern, early twenties, tidy ponytail, white shirt and blazer, nervous eager smile, stacks of case files',
    promptZh: '二十出头的中国律所女实习生，整齐马尾，白衬衫与西装外套，紧张又热切的笑，成堆案卷' },
  { key: 'suwanzhou-wenyan-jianglvshi', file: 'suwanzhou-wenyan-jianglvshi.jpg', style: 'modern',
    promptEn: 'Chinese male opposing counsel, forties, sharp features, grey three-piece suit, cold polite smile, courtroom',
    promptZh: '四十多岁的中国男对手律师，五官锋利，灰色三件套西装，冷淡客气的笑，法庭' },
  // 12 188霸总&闯祸写手（现代·都市）
  { key: 'lusinian-chuanghuo-hechuan', file: 'lusinian-chuanghuo-hechuan.jpg', style: 'modern',
    promptEn: 'young Chinese male executive assistant, early thirties, neat glasses, black suit, tablet under arm, skyscraper lobby',
    promptZh: '三十出头的中国男特助，整齐眼镜，黑西装，臂下夹着平板，写字楼大堂' },
  { key: 'lusinian-chuanghuo-xiajie', file: 'lusinian-chuanghuo-xiajie.jpg', style: 'modern',
    promptEn: 'Chinese woman editor, thirties, loose cardigan, coffee in hand, wry smile, cluttered editorial desk',
    promptZh: '三十多岁的中国女编辑，宽松开衫，手拿咖啡，无奈的笑意，堆满稿件的编辑桌' },
  { key: 'lusinian-chuanghuo-lumu', file: 'lusinian-chuanghuo-lumu.jpg', style: 'modern',
    promptEn: 'elegant modern Chinese society lady, sixties, immaculate updo, pearl earrings, fur-collared modern coat, cold appraisal, contemporary mansion drawing room, no period costume',
    promptZh: '现代中国贵妇，六十多岁，一丝不苟的盘发，珍珠耳环，现代毛领大衣，冷淡打量的目光，现代宅邸客厅（不是古装）' },
  // 13 严重洁癖总裁&拿错外卖实习生（现代·职场）
  { key: 'luyan-waimai-fangtezhu', file: 'luyan-waimai-fangtezhu.jpg', style: 'modern',
    promptEn: 'young Chinese male special assistant, early thirties, tidy suit, white gloves, apologetic smile, executive corridor',
    promptZh: '三十出头的中国男特别助理，整齐西装，白手套，赔笑，总裁办公楼走廊' },
  { key: 'luyan-waimai-xiaoyu', file: 'luyan-waimai-xiaoyu.jpg', style: 'modern',
    promptEn: 'young Chinese female intern, early twenties, bun, office blouse, holding a takeaway bag, worried look, office pantry',
    promptZh: '二十出头的中国女实习生，丸子头，通勤衬衫，手里拎着外卖袋，发愁的表情，茶水间' },
  { key: 'luyan-waimai-wangshu', file: 'luyan-waimai-wangshu.jpg', style: 'modern',
    promptEn: 'Chinese middle-aged shop owner, fifties, apron, friendly weathered face, small Japanese barbecue restaurant at night',
    promptZh: '五十多岁的中国小店老板，围裙，和善饱经风霜的脸，夜里的小日式烧肉店' },
  // 14 冷面总裁&哑巴新娘（现代·豪门）
  { key: 'fuxingzhou-yaba-zhongshu', file: 'fuxingzhou-yaba-zhongshu.jpg', style: 'modern',
    promptEn: 'elderly Chinese head butler, sixties, grey hair combed back, black tailcoat, sombre loyal, old mansion hall',
    promptZh: '六十多岁的中国老管家，向后梳的灰发，黑燕尾服，沉肃忠诚，老宅门厅' },
  { key: 'fuxingzhou-yaba-fumu', file: 'fuxingzhou-yaba-fumu.jpg', style: 'modern',
    promptEn: 'modern Chinese matriarch, late fifties, tight bun, dark modern qipao with a jade brooch, disdainful gaze, contemporary luxury dining room, no period costume',
    promptZh: '现代中国贵妇，五十七八岁，紧盘发，现代深色旗袍配玉胸针，不屑的目光，现代豪华餐厅（不是古装）' },
  { key: 'fuxingzhou-yaba-linwei', file: 'fuxingzhou-yaba-linwei.jpg', style: 'modern',
    promptEn: 'young Chinese woman, late twenties, shoulder-length hair, plain cream blouse (not a lab coat), worried determined eyes, hospital corridor',
    promptZh: '二十八九岁的中国女人，齐肩发，素色米白衬衫（不是白大褂），担忧而坚定的眼睛，医院走廊' },
  // 15 封建世家家主&留洋大小姐（古代·世家）
  { key: 'shenyanzhi-liuyang-shenfu', file: 'shenyanzhi-liuyang-shenfu.jpg', style: 'ancient',
    promptEn: 'old Chinese household steward, sixties, grey beard, plain dark changshan robe, hands folded, austere ancestral hall',
    promptZh: '六十多岁的中国老管家，花白胡须，素色深色长衫，双手交叠，肃穆的宗祠' },
  { key: 'shenyanzhi-liuyang-shenlaotaitai', file: 'shenyanzhi-liuyang-shenlaotaitai.jpg', style: 'ancient',
    promptEn: 'old Chinese noble matriarch, seventies, silver hair in a high bun with a jade pin, dark brocade robe, unbending stare',
    promptZh: '七十多岁的中国老夫人，银发高髻插玉簪，深色锦缎长袄，不容置辩的目光' },
  { key: 'shenyanzhi-liuyang-songzhiyuan', file: 'shenyanzhi-liuyang-songzhiyuan.jpg', style: 'ancient',
    promptEn: 'young Chinese gentleman back from abroad, twenties, short modern haircut, western waistcoat over a Chinese robe, easy smile',
    promptZh: '二十多岁留洋归来的中国年轻少爷，短发，中式长衫外搭西式马甲，洒脱的笑' },
  // 16 情感漠视丈夫&产后抑郁妻子（现代·家庭，多角色支线：家里三条不同声音）
  { key: 'guhuaizhi-chanhou-zhangjie', file: 'guhuaizhi-chanhou-zhangjie.jpg', style: 'modern',
    promptEn: 'Chinese maternity nurse, forties, short hair, soft blue uniform, warm steady expression, quiet nursery at dusk',
    promptZh: '四十多岁的中国月嫂，短发，浅蓝工作服，温暖而笃定的神情，黄昏安静的婴儿房' },
  { key: 'guhuaizhi-chanhou-gumu', file: 'guhuaizhi-chanhou-gumu.jpg', style: 'modern',
    promptEn: 'Chinese mother-in-law, late fifties, permed short hair, knitted cardigan, dismissive tight smile, modern living room',
    promptZh: '五十七八岁的中国婆婆，烫过的短发，针织开衫，敷衍而紧绷的笑，现代客厅' },
  { key: 'guhuaizhi-chanhou-linyisheng', file: 'guhuaizhi-chanhou-linyisheng.jpg', style: 'modern',
    promptEn: 'Chinese female doctor, thirties, short hair, white coat over a plain shirt, concerned firm gaze, clinic consulting room',
    promptZh: '三十多岁的中国女医生，短发，白大褂内搭素色衬衫，关切而坚定的目光，诊室' },
  // 17 毒舌雇主&家教兼酒妹（现代·都市）
  { key: 'luci-jiajiao-luxing', file: 'luci-jiajiao-luxing.jpg', style: 'modern',
    promptEn: 'Chinese high school boy, seventeen, neat short hair, school shirt, sulky clever look, tidy study desk',
    promptZh: '十七岁中国高中男生，利落短发，校服衬衫，不服气又机灵的神情，整洁书桌' },
  { key: 'luci-jiajiao-lanjie', file: 'luci-jiajiao-lanjie.jpg', style: 'modern',
    promptEn: 'Chinese nightclub floor manager, thirties, sleek ponytail, black shirt, cigarette between fingers, neon lounge',
    promptZh: '三十多岁的中国商K领班，利落马尾，黑衬衫，指间夹烟，霓虹包厢' },
  { key: 'luci-jiajiao-aqian', file: 'luci-jiajiao-aqian.jpg', style: 'modern',
    promptEn: 'young Chinese man, late twenties, expensive casual shirt, knowing smirk, private club booth at night',
    promptZh: '二十七八岁的中国男人，昂贵休闲衬衫，了然而戏谑的笑，夜里私人会所卡座' },
  // 18 清高才子&被忽视的新婚佳人（古代·文人）
  { key: 'chengqingyan-xinhuang-lixiu', file: 'chengqingyan-xinhuang-lixiu.jpg', style: 'ancient',
    promptEn: 'a young Chinese man of twenty-eight, clean shaven no beard, scholar cap, pale blue robe, ink brush in hand, close-up face and shoulders, front view, plain dark background',
    promptZh: '二十八岁的年轻中国男子，没有胡子，文士巾，月白长衫，手执毛笔，面部与肩部特写，正面，素色深色背景' },
  { key: 'chengqingyan-xinhuang-linlaofuren', file: 'chengqingyan-xinhuang-linlaofuren.jpg', style: 'ancient',
    promptEn: 'Chinese noble old lady, sixties, silver hair in a bun, brown and gold brocade jacket, concerned stern face, family hall',
    promptZh: '六十多岁的中国老夫人，银发盘髻，褐金锦缎褂子，关切而严厉的神情，家宅厅堂' },
  { key: 'chengqingyan-xinhuang-yunniang', file: 'chengqingyan-xinhuang-yunniang.jpg', style: 'ancient',
    promptEn: 'young Chinese female dancer, early twenties, elegant updo with a red ribbon, red and cream silk dance dress, holding a round fan, calm knowing gaze, front view, bust portrait, plain deep red background',
    promptZh: '二十出头的年轻中国舞姬，优雅盘发系红绸带，红白丝绸舞衣，手持团扇，平静了然的目光，正面，半身肖像，纯净深红背景' },
  // 19 狂躁症总裁&被困千金（现代·都市，多角色支线：医生与妹妹两条外部视角）
  { key: 'fuyanci-kunjing-xuyisheng', file: 'fuyanci-kunjing-xuyisheng.jpg', style: 'modern',
    promptEn: 'Chinese male psychiatrist, forties, thin glasses, grey knit vest over shirt, calm unshakeable gaze, quiet consulting room',
    promptZh: '四十多岁的中国男心理医生，细框眼镜，衬衫外针织背心，平静不移的目光，安静诊室' },
  { key: 'fuyanci-kunjing-fuyao', file: 'fuyanci-kunjing-fuyao.jpg', style: 'modern',
    promptEn: 'young Chinese woman, mid twenties, short bob, casual dark coat, worried stubborn look, rain-wet garden path at night',
    promptZh: '二十四五岁的中国女人，短发波波头，深色休闲外套，担忧又倔强的神情，雨夜花园小径' },
  { key: 'fuyanci-kunjing-wenfu', file: 'fuyanci-kunjing-wenfu.jpg', style: 'modern',
    promptEn: 'Chinese businessman father, late fifties, greying hair, expensive coat, guilt and authority, hotel lobby at night',
    promptZh: '五十七八岁的中国父亲，花白头发，昂贵外套，愧疚与威严并存，夜里酒店大堂' },
  // 20 粘人精男友&心虚躲闪的你（现代·都市）
  { key: 'luyu-nvpengyou-dapeng', file: 'luyu-nvpengyou-dapeng.jpg', style: 'modern',
    promptEn: 'Chinese male software coworker, early thirties, hoodie, coffee mug, easy grin, open-plan internet office',
    promptZh: '三十出头的中国男程序员同事，卫衣，马克杯，随和的笑，开放式互联网办公室' },
  { key: 'luyu-nvpengyou-chengyue', file: 'luyu-nvpengyou-chengyue.jpg', style: 'modern',
    promptEn: 'Chinese young man in an old photograph come to life, mid twenties, simple white shirt, calm gentle gaze, sunlit school corridor',
    promptZh: '照片里走出来的中国年轻男人，二十四五岁，简单白衬衫，平静温和的目光，阳光下的校园走廊' },
  { key: 'luyu-nvpengyou-taotao', file: 'luyu-nvpengyou-taotao.jpg', style: 'modern',
    promptEn: 'young Chinese woman roommate, mid twenties, oversized sweater, holding a mug, observing knowingly, shared apartment living room',
    promptZh: '二十四五岁的中国女合租室友，大号毛衣，端着杯子，看破不说破，合租公寓客厅' },

  // ===== 第三批（21–30 中适合群像的 9 部）=====
  // 21 薄情帝王&痴傻皇后（古代·宫廷）
  { key: 'xiaoyan-chisha-xietaihou', file: 'xiaoyan-chisha-xietaihou.jpg', style: 'ancient',
    promptEn: 'Chinese dowager empress, mid forties, tall elaborate updo with gold phoenix hairpins, dark crimson and black court robe with a wide collar, cold assessing gaze, close-up bust portrait, head and shoulders, face fills the frame',
    promptZh: '四十多岁的中国太后，高耸繁复的盘发配金凤簪，深红配黑的宽领朝服，冷峻审视的目光，特写半身肖像，面部充满画面' },
  { key: 'xiaoyan-chisha-liuchengxiang', file: 'xiaoyan-chisha-liuchengxiang.jpg', style: 'ancient',
    promptEn: 'Chinese chancellor, fifties, long grey beard, black official cap with winged sides, dark blue court robe, composed shrewd expression, ancient court hall',
    promptZh: '五十多岁的中国宰相，长灰须，两侧带翅的黑色官帽，深蓝朝服，沉稳精明的神情，古代朝堂' },
  { key: 'xiaoyan-chisha-qinghe', file: 'xiaoyan-chisha-qinghe.jpg', style: 'ancient',
    promptEn: 'young Chinese palace maid, eighteen, two small hair buns, pale green palace dress with crossed collar, careful gentle eyes, ancient palace corridor with lattice windows',
    promptZh: '十八岁的中国宫女，双丫髻，浅绿交领宫装，细心温和的眼神，木格窗的古代宫殿长廊' },
  // 22 隐藏富豪小少爷&清醒女友（现代·校园）
  { key: 'chenboyuan-qingxing-akuan', file: 'chenboyuan-qingxing-akuan.jpg', style: 'modern',
    promptEn: 'Chinese takeout delivery rider, mid twenties, short cropped hair, yellow delivery jacket over a hoodie, honest open grin, city street at dusk',
    promptZh: '二十四五岁的中国外卖骑手，短寸头，卫衣外穿黄色骑手外套，诚恳开朗的笑，傍晚的城市街头' },
  { key: 'chenboyuan-qingxing-chenfu', file: 'chenboyuan-qingxing-chenfu.jpg', style: 'modern',
    promptEn: 'Chinese business patriarch, late fifties, greying combed-back hair, dark expensive suit, cold restrained expression, glass-walled office at night',
    promptZh: '五十七八岁的中国家族企业掌权人，花白背头，深色昂贵西装，克制冷淡的神情，夜里玻璃幕墙办公室' },
  { key: 'chenboyuan-qingxing-miaomiao', file: 'chenboyuan-qingxing-miaomiao.jpg', style: 'modern',
    promptEn: 'young Chinese woman, early twenties, messy bun, oversized knit sweater, sharp observant look, student apartment living room',
    promptZh: '二十出头的中国女孩，随手挽起的发髻，大号针织毛衣，敏锐爱观察的神情，学生公寓客厅' },
  // 24 刺杀失败后成为暴君贵妃（古代·宫廷）
  { key: 'shenyu-lingchaoyue-gaodequan', file: 'shenyu-lingchaoyue-gaodequan.jpg', style: 'ancient',
    promptEn: 'Chinese imperial eunuch, fifties, hairless smooth face, round black gauze cap, dark red palace eunuch robe, obsequious vigilant expression, close-up bust portrait, head and shoulders, face fills the frame',
    promptZh: '五十多岁的中国御前太监，无须光洁的面孔，圆黑纱帽，深红宫袍，恭顺而警觉的神情，特写半身肖像，面部充满画面' },
  { key: 'shenyu-lingchaoyue-lutaiyi', file: 'shenyu-lingchaoyue-lutaiyi.jpg', style: 'ancient',
    promptEn: 'Chinese imperial physician, forties, neat moustache, black gauze official cap, dark green robe, a medicine box under one arm, calm discreet gaze',
    promptZh: '四十多岁的中国太医，整齐的短须，黑纱官帽，深绿官袍，臂下夹着药箱，平静谨慎的目光' },
  { key: 'shenyu-lingchaoyue-dachangongzhu', file: 'shenyu-lingchaoyue-dachangongzhu.jpg', style: 'ancient',
    promptEn: 'Chinese grand princess, early fifties, high jade-studded bun, deep purple and gold court robe, severe proud expression, close-up bust portrait, head and shoulders, face fills the frame',
    promptZh: '五十出头的中国大长公主，高耸嵌玉发髻，深紫配金的礼服，严厉高傲的神情，特写半身肖像，面部充满画面' },
  // 25 你也不想让丈夫知道吧（现代·都市）
  { key: 'peizhisheng-suwan-zhousheng', file: 'peizhisheng-suwan-zhousheng.jpg', style: 'modern',
    promptEn: 'Chinese office worker husband, early thirties, plain short hair, wrinkled light blue shirt and loosened tie, tired anxious face, apartment corridor',
    promptZh: '三十出头的中国上班族丈夫，普通的短发，起皱的浅蓝衬衫与松开的领带，疲惫不安的神情，公寓楼道' },
  { key: 'peizhisheng-suwan-hemishu', file: 'peizhisheng-suwan-hemishu.jpg', style: 'modern',
    promptEn: 'Chinese male secretary, thirties, neat side-parted hair, slim black suit, unreadable careful expression, glass office tower lobby',
    promptZh: '三十多岁的中国男秘书，整齐侧分头发，修身黑西装，看不出心思的谨慎神情，玻璃幕墙写字楼大堂' },
  { key: 'peizhisheng-suwan-sunian', file: 'peizhisheng-suwan-sunian.jpg', style: 'modern',
    promptEn: 'young Chinese woman, mid twenties, long straight hair, camel coat and scarf, worried direct gaze, city cafe at night',
    promptZh: '二十四五岁的中国女人，长直发，驼色大衣配围巾，担忧而直接的目光，夜晚的城市咖啡馆' },
  // 26 乖乖，别抛弃我（现代·娱乐圈）
  { key: 'shenshu-jiangjia-zhaojie', file: 'shenshu-jiangjia-zhaojie.jpg', style: 'modern',
    promptEn: 'Chinese woman in her forties, short permed hair, black blazer over a white blouse, phone in one hand, brisk capable look, backstage corridor',
    promptZh: '四十多岁的中国女人，短卷发，白衬衫外搭黑色西装外套，一手拿着手机，干练利落的神情，后台走廊' },
  { key: 'shenshu-jiangjia-jiangli', file: 'shenshu-jiangjia-jiangli.jpg', style: 'modern',
    promptEn: 'young Chinese actress, mid twenties, glossy long hair, elegant sequined gown, cool competitive smile, gala red carpet',
    promptZh: '二十四五岁的中国女星，光泽长直发，优雅亮片礼服，冷淡好胜的微笑，晚会红毯' },
  { key: 'shenshu-jiangjia-shenmu', file: 'shenshu-jiangjia-shenmu.jpg', style: 'modern',
    promptEn: 'Chinese society matron, late fifties, immaculate chignon, pearl necklace and dark silk cheongsam, haughty composed look, old family mansion hall',
    promptZh: '五十七八岁的中国贵妇，一丝不苟的盘发，珍珠项链与深色丝质旗袍，高傲沉稳的神情，老宅厅堂' },
  // 27 你只能是朕的皇后（古代·宫廷）
  { key: 'xiaoyan-qianqian-liutaihou', file: 'xiaoyan-qianqian-liutaihou.jpg', style: 'ancient',
    promptEn: 'Chinese empress dowager, a woman in her forties, smooth pale face with no facial hair, tall black bun with a silver phoenix hairpin, dark teal robe with gold trim, dignified guarded expression, close-up bust portrait, head and shoulders',
    promptZh: '四十多岁的中国太后（女人），光洁面孔、无胡须，高耸黑发髻配银凤簪，深青配金边礼服，端庄防备的神情，特写半身肖像，头肩构图' },
  { key: 'xiaoyan-qianqian-laochengxiang', file: 'xiaoyan-qianqian-laochengxiang.jpg', style: 'ancient',
    promptEn: 'Chinese old chancellor, a man in his sixties, long white beard and white eyebrows, black winged official cap, deep grey court robe, dignified sorrowful expression, close-up bust portrait, head and shoulders',
    promptZh: '六十多岁的中国老丞相（男人），白色长须与白眉，黑色带翅官帽，深灰朝服，端庄悲怆的神情，特写半身肖像，头肩构图' },
  { key: 'xiaoyan-qianqian-mengnvguan', file: 'xiaoyan-qianqian-mengnvguan.jpg', style: 'ancient',
    promptEn: 'Chinese court female official, thirties, hair in a tight neat bun with a plain silver pin, grey-blue palace robe, quiet watchful eyes, close-up bust portrait, head and shoulders, face fills the frame',
    promptZh: '三十多岁的中国女官，一丝不苟的紧盘发配素银簪，灰蓝宫袍，安静审视的目光，特写半身肖像，面部充满画面' },
  // 28 求求你，摸摸我吧（现代·都市）
  { key: 'shenjian-jiangnian-shenayi', file: 'shenjian-jiangnian-shenayi.jpg', style: 'modern',
    promptEn: 'Chinese mother, fifties, soft short hair, beige knit cardigan, gentle worried smile, warm family living room',
    promptZh: '五十多岁的中国母亲，柔顺短发，米色针织开衫，温和担忧的微笑，温暖的家庭客厅' },
  { key: 'shenjian-jiangnian-linlaoshi', file: 'shenjian-jiangnian-linlaoshi.jpg', style: 'modern',
    promptEn: 'Chinese sign language teacher, mid thirties, round glasses, brown knit sweater, patient kind expression, quiet study room',
    promptZh: '三十五六岁的中国手语老师，圆框眼镜，棕色针织毛衣，耐心和善的神情，安静的书房' },
  { key: 'shenjian-jiangnian-liuyi', file: 'shenjian-jiangnian-liuyi.jpg', style: 'modern',
    promptEn: 'Chinese neighbourhood auntie, sixties, short curly hair, floral blouse and apron, chatty fond smile, old residential stairwell',
    promptZh: '六十多岁的中国邻居阿姨，短卷发，碎花衬衫配围裙，爱说话又亲切的笑，老居民楼楼道' },
  // 29 雨夜捡到的他会暖床（现代·都市）
  { key: 'lijinyan-xiaxia-wangshen', file: 'lijinyan-xiaxia-wangshen.jpg', style: 'modern',
    promptEn: 'Chinese neighbour woman, fifties, short hair, house dress with a cardigan, suspicious sidelong look, apartment hallway',
    promptZh: '五十多岁的中国邻居妇人，短发，家常连衣裙外搭开衫，狐疑的侧目，公寓走廊' },
  { key: 'lijinyan-xiaxia-laogui', file: 'lijinyan-xiaxia-laogui.jpg', style: 'modern',
    promptEn: 'Chinese man, forties, buzz cut, stubble, dark worn jacket, cold tight smile, rainy alley at night',
    promptZh: '四十多岁的中国男人，板寸，胡茬，深色磨旧外套，冷淡紧绷的笑，雨夜巷子' },
  { key: 'lijinyan-xiaxia-xiaotang', file: 'lijinyan-xiaxia-xiaotang.jpg', style: 'modern',
    promptEn: 'young Chinese office woman, mid twenties, ponytail, white shirt, coffee cup in hand, teasing knowing look, office pantry',
    promptZh: '二十四五岁的中国女同事，马尾，白衬衫，手里端着咖啡，打趣会意的神情，办公室茶水间' },
  // 30 捡回来的少年只想守着姐姐（现代·都市）
  { key: 'linzhao-xiaxia-laoli', file: 'linzhao-xiaxia-laoli.jpg', style: 'modern',
    promptEn: 'Chinese corner shop owner, sixties, flat cap, grey work jacket, kindly weathered face, old alley storefront',
    promptZh: '六十多岁的中国小卖部老板，鸭舌帽，灰色工作外套，饱经风霜的和善面孔，老巷子店面' },
  { key: 'linzhao-xiaxia-aning', file: 'linzhao-xiaxia-aning.jpg', style: 'modern',
    promptEn: 'young Chinese woman, mid twenties, shoulder-length hair, denim jacket, protective worried expression, old alley at dusk',
    promptZh: '二十四五岁的中国女孩，齐肩发，牛仔外套，护着你的担忧神情，黄昏的老巷子' },
  { key: 'linzhao-xiaxia-zhaodefa', file: 'linzhao-xiaxia-zhaodefa.jpg', style: 'modern',
    promptEn: 'Chinese man, forties, short messy hair, worn brown jacket, hard tired face, old alley doorway',
    promptZh: '四十多岁的中国男人，凌乱短发，磨旧的棕色夹克，强硬而疲惫的面孔，老巷子门口' },
];

function toJpg(bytes: Buffer, ext: string): Buffer {
  if (ext === 'jpg' || ext === 'jpeg') return bytes;
  const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  const src = path.join(os.tmpdir(), 'cast-' + stamp + '.' + ext);
  const dst = path.join(os.tmpdir(), 'cast-' + stamp + '.jpg');
  fs.writeFileSync(src, bytes);
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-q:v', '4', dst], { stdio: 'pipe' });
    return fs.readFileSync(dst);
  } finally {
    try { fs.unlinkSync(src); } catch { /* 忽略 */ }
    try { fs.unlinkSync(dst); } catch { /* 忽略 */ }
  }
}

const provider = (providerArg || resolveProviderId()) as ReturnType<typeof resolveProviderId>;
const rows = only.length ? ROWS.filter(r => only.includes(r.key)) : ROWS;
const readyNote = provider === 'sidecar' ? '（注意：sidecar 的 ready 恒为 true，真实可用性看 8004/health）' : '';
console.log('[' + provider + '] ' + providerModel(provider) + ' | ready=' + providerReady(provider) + readyNote + ' | ' + W + 'x' + H + ' | ¥' + priceOfProvider(provider) + '/张 | 待出 ' + rows.length + ' 张（约 ¥' + (priceOfProvider(provider) * rows.length).toFixed(2) + '）');

if (rows.length === 0) { console.error('❌ --only 没匹配到任何 key：' + only.join(',')); process.exit(2); }
if (has('--dry-run')) { for (const r of rows) console.log('  [dry] ' + r.key + ' [' + r.style + '] -> ' + r.file); process.exit(0); }
if (!providerReady(provider)) { console.error('❌ 后端未配置 Key，无法出图'); process.exit(2); }

fs.mkdirSync(outDir, { recursive: true });
let failed = 0;
for (const r of rows) {
  const useEn = provider !== 'wanx'; // SDXL/侧车只认英文；wanx 中文更准
  const st = STYLES[r.style];
  const style = useEn ? st.en : st.zh;
  const body = useEn ? r.promptEn : r.promptZh;
  for (let v = 0; v < variants; v++) {
    const dest = path.join(outDir, variants > 1 ? r.file.replace(/\.jpg$/, '-v' + v + '.jpg') : r.file);
    const seedKey = r.key + (v ? '-v' + v : '');
    process.stdout.write('... ' + seedKey + ' ');
    const out = await generateImage(
      { prompt: style + (useEn ? ', ' : '。') + body, negative: st.negative, width: W, height: H, seed: stableSeed(seedKey) },
      { provider, timeoutMs: 180000 },
    );
    if (!out.ok || !out.bytes) {
      failed += 1;
      console.log('❌ ' + (out.code || 'FAIL') + ' ' + (out.message || ''));
      if (out.fatal) { console.error('账号级错误（额度/Key）→ 中止整批'); break; }
      continue;
    }
    const jpg = toJpg(out.bytes, out.ext || 'jpg');
    fs.writeFileSync(dest, jpg);
    console.log('✅ ' + path.basename(dest) + ' (' + Math.round(jpg.length / 1024) + ' KB, ' + (out.seconds || 0) + 's)');
  }
}
console.log(failed ? ('完成，失败 ' + failed + ' 张') : '完成');
process.exit(failed ? 1 : 0);

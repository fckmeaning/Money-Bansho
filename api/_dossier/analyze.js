/**
 * Company Dossier analysis: headline classification, de-duplication, price reaction
 * and reputation scoring. Pure ESM, safe for the edge runtime.
 * The numeric model lives in quant.js (see docs/bansho-math.md).
 *
 * Everything here is keyword based and deterministic. Where a signal is uncertain the
 * result is empty/null instead of a guess.
 */

import { evidenceWeight, MAX_GAP, PRIOR_WEIGHT, scoreUncertainty, withCloseTimes } from './quant.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const round2 = (n) => Math.round(n * 100) / 100 || 0;
/** Join regex fragments into one alternation. */
const alt = (...parts) => parts.join('|');

// ---------------------------------------------------------------------------
// Language
// ---------------------------------------------------------------------------

function detectLang(title, lang) {
  // Non-Latin scripts are unambiguous and override a wrong feed label.
  if (/[가-힣]/.test(title)) return 'ko';
  if (/[֐-׿]/.test(title)) return 'he';
  if (/[一-鿿]/.test(title)) return 'zh';
  const code = String(lang || '').toLowerCase().slice(0, 2);
  return code === 'de' || code === 'fr' ? code : 'en';
}

/** Unify typographic quotes (incl. Hebrew gershayim) so that lexicons match. */
function normalizeText(title) {
  return String(title || '')
    .normalize('NFC')
    .replace(/[‘’׳]/g, "'")
    .replace(/[“”„״]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// Unicode-aware word start/end for Latin-script lexicons (\b breaks on accents).
const latin = (source) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${source})(?![\\p{L}\\p{N}])`, 'iu');
const plain = (source) => new RegExp(source, 'u');

// ---------------------------------------------------------------------------
// Leadership changes
// ---------------------------------------------------------------------------

const EN_ROLE = '(?<!(?:police|fire|army|defen[cs]e|military|spy|AI|design|marketing|product|sales|HR|policy|legal|research|security|cloud|hardware|software) (?=chief(?! (?:executive|financial))))(?:CEO|CFO|C\\.E\\.O\\.|chief executive(?: officer)?|chief financial officer|finance chief|finance director|managing director|executive chair(?:man|woman)?|chair(?:man|woman|person)?|co-?founders?|founders?|boss|chief(?! (?:of staff|economist|technology|marketing|operating|legal|product|information|people|scientist|strategy|strategist|investment|analyst|justice|designer|engineer|medical|revenue|commercial)))';

// Verbs/nouns that may FOLLOW the role: "CEO resigns", "founder arrested".
const EN_AFTER = alt(
  'resign(?:s|ed|ing|ation)?', 'steps? down', 'stepped down', 'stepping down', 'stands? down', 'stood down',
  'quit(?:s|ting)?', 'retir(?:es|ed|ing|ement)', 'to retire', 'will retire', 'to leave', 'to depart', 'leav(?:es|ing)(?! (?:the )?door| for\\b)', 'returns?(?= as\\b)',
  'departs?', 'departing', 'departure', 'exits?', 'exiting', 'ouste(?:d|r)', 'fired(?! up)', 'firing', 'sacked', 'removed', 'forced out',
  'dismiss(?:ed|al)', 'replaced', 'arrest(?:ed)?', 'detain(?:ed)?', 'detention', 'indict(?:ed|ment)', 'jailed', 'charged', 'sentenced',
  'taken into custody', 'appoint(?:ed|ment)', 'named(?! in\\b)', 'elected', 'promoted', 'hired', 'succession',
  'to step aside', 'steps? aside', 'is out',
);

// Verbs that may PRECEDE the role: "appoints X as CEO", "steps down as chairman".
const EN_BEFORE = alt(
  'appoint(?:s|ed|ing)?', 'appointment of', 'names?(?! (?:in|after)\\b)', 'named(?! (?:in|after)\\b)', 'poach(?:es|ed)', 'return(?:s|ed|ing)?(?= (?:[\\p{L}]+ ){0,2}as\\b)', 'naming', 'taps?(?! into)', 'tapped', 'hir(?:es|ed|ing)', 'picks?(?! up)', 'picked',
  'promot(?:es|ed)', 'elect(?:s|ed)', 'oust(?:s|ed|ing)?', 'ouster of', 'fir(?:es|ed|ing)(?! back| up)', 'sack(?:s|ed)', 'remov(?:es|ed)',
  'replac(?:es|ed|ing)', 'dismiss(?:es|ed)', 'arrest(?:s|ed)?', 'arrest of', 'detain(?:s|ed)?', 'indict(?:s|ed)', 'charges', 'jails',
  'resign(?:s|ed|ing)?', 'resignation of', 'steps? down', 'stepped down', 'stepping down', 'stands? down', 'quits?', 'retir(?:es|ed|ing)', 'to retire',
  'takes? over', 'succeed(?:s|ed)?', 'joins?(?= [^;|]{0,30}\\bas\\b)', 'becomes?', 'to become', 'to be(?= (?:the )?(?:new |next )?(?:CEO|CFO|chair))',
  'out(?= as\\b)', 'sworn in as',
);

// A gap containing any of these means the verb most likely belongs to someone/something else.
const EN_BLOCK_COMMON = 'says?|said|warns?|warned|tells?|told|slams|calls?|wants?|vows?|expects?|staff|workers?|employees?|engineers?|jobs|shares?|stock';
const EN_GAP_AFTER = new RegExp(`\\b(?:${EN_BLOCK_COMMON}|sales|profits?|after|amid|over|while|when|who|by|for|as|plans?)\\b|[;|:?!]|\\d{3,}`, 'i');
const EN_GAP_BEFORE = new RegExp(`\\b(?:${EN_BLOCK_COMMON}|with|about|by|back|report(?:s|ing)? to|meets?|honou?r|tribute|memory)\\b|[;|:?!]|\\d{3,}`, 'i');

const EN_NOUN = alt(
  '(?:new|next|interim|incoming|acting) (?:group |global )?(?:CEO|CFO|chief executive|chief financial officer|chair(?:man|woman|person)?)',
  '(?:CEO|CFO|chief executive|chairman|founder|boss)(?:\'s)? (?:(?:sudden|abrupt|surprise|shock) )?(?:resignation|exit|departure|ouster|arrest|succession|shake-?up|transition|change)',
  '(?:leadership|management|C-suite) (?:change|shake-?up|transition|overhaul|reshuffle)',
);

const EN_NEGATION = new RegExp(
  "\\b(?:won't|will not|not (?:going to |planning to |to )?|no plans? to|never|den(?:y|ies|ied)|rejects?|refus\\w+ to|calls? (?:for|on)|urg\\w+|pressure[sd]? to|should|must)\\b[^;|]{0,45}?\\b(?:step(?:ping|s)? (?:down|aside)|resign\\w*|quit\\w*|leav\\w+|retir\\w+|exit\\w*|depart\\w+|ouster|replac\\w+|fired|sacked)\\b" +
  '|\\b(?:resignation|exit|departure|arrest)\\b[^;|]{0,20}\\b(?:denied|rumou?rs?|speculation)\\b' +
  '|\\brumou?rs? (?:of|about)\\b[^;|]{0,30}\\b(?:resignation|exit|departure|arrest)\\b',
  'i',
);

function isLeadershipEn(text) {
  if (EN_NEGATION.test(text)) return false;
  if (latin(EN_NOUN).test(text)) return true;
  const roles = [...text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])(?:${EN_ROLE})(?![\\p{L}\\p{N}-])`, 'giu'))];
  if (!roles.length) return false;
  const verbs = (source) => [...text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}-])(?:${source})(?![\\p{L}\\p{N}])`, 'giu'))];
  const after = verbs(EN_AFTER);
  const before = verbs(EN_BEFORE);
  return roles.some((role) => {
    const start = role.index;
    const end = start + role[0].length;
    const followed = after.some((v) => {
      if (v.index < end || v.index - end > 60) return false;
      const gap = text.slice(end, v.index);
      // "CEO's resignation" is fine, "CEO's plan to retire old jets" is not.
      if (/^'s\b/.test(gap) && !/^'s (?:(?:sudden|abrupt|surprise|shock) )?$/.test(gap)) return false;
      return !EN_GAP_AFTER.test(gap);
    });
    if (followed) return true;
    // "..., CEO says" / "CEO's comments" do not describe a change of that role.
    if (/^(?:'s\b(?! (?:successor|replacement|job|post|role))| (?:says|said|warns|tells|visit|call|comments?|remarks|speech|meeting|pay)\b)/i.test(text.slice(end))) return false;
    return before.some((v) => {
      const vEnd = v.index + v[0].length;
      return vEnd <= start && start - vEnd <= 55 && !EN_GAP_BEFORE.test(text.slice(vEnd, start));
    });
  });
}

/** Role and change word close to each other, in either order. */
const OTHER_LEADERSHIP = {
  de: {
    role: latin(alt(
      '(?:[\\p{L}\\d&.]+-)?(?:CEO|CFO|Chefin|Chef|Boss|Vorstandschef(?:in)?|Konzernchef(?:in)?|Firmenchef(?:in)?|Finanzchef(?:in)?|Finanzvorstand|Vorstandsvorsitzende[rn]?|Aufsichtsratschef(?:in)?|Aufsichtsratsvorsitzende[rn]?|Gründer(?:in|s)?|Geschäftsführer(?:in|s)?)',
      'Vorstandschefs|Konzernchefs|Chefs',
    )),
    change: latin(alt(
      'zurück(?:treten|getreten|tritt)?', 'tritt [^;|]{0,40}?zurück', 'Rücktritt', 'ernannt', 'ernennt', 'beruft', 'berufen', 'Berufung', 'Nachfolger(?:in)?', 'Nachfolge',
      'übernimmt', 'folgt auf', 'verlässt', 'scheidet aus', 'abgesetzt', 'Absetzung', 'Abgang', 'Abschied', 'entlassen', 'Entlassung', 'gefeuert', 'muss gehen',
      'geht in den Ruhestand', 'geht von Bord', 'verhaftet', 'festgenommen', 'Festnahme', 'Verhaftung', 'in Haft', 'angeklagt', 'Wechsel an der Spitze',
      'wird(?= (?:neue[rn]? )?[\\p{L}-]*(?:Chef|CEO|CFO|Vorstand))', 'neue[rn]?(?= [\\p{L}-]*(?:Chef|CEO|CFO|Finanzvorstand|Vorstandsvorsitz))',
    )),
    negation: latin('nicht zurück(?:treten)?|tritt nicht [^;|]{0,20}?zurück|dementiert|schließt Rücktritt aus|lehnt Rücktritt ab|fordert[^;|]{0,40}Rücktritt|Rücktrittsforderung(?:en)?'),
  },
  fr: {
    role: latin(alt(
      'PDG|P-DG|DG|CEO|CFO', 'direct(?:eur|rice) général[e]?', 'direct(?:eur|rice) financi(?:er|ère)', 'patron(?:ne)?', 'fondat(?:eur|rice)', 'cofondat(?:eur|rice)',
      'président(?:e)?(?=[- ](?:du conseil|du directoire|directeur|directrice|exécutif|exécutive))', 'chef de la direction',
    )),
    change: latin(alt(
      'démissionn(?:e|é|ée|era|ent)', 'démission', 'quitte(?:ra)?', 'départ', 'nommée?', 'nomme', 'nomination', 'succède', 'succession', 'successeur', 'remplacée?', 'remplace',
      'prend (?:la tête|les rênes)', 'limogée?', 'limogeage', 'évincée?', 'éviction', 'écartée?', 'arrêtée?', 'arrestation', 'interpellée?', 'interpellation',
      'mise? en examen', 'se retire', 'incarcérée?', 'placée? en (?:détention|garde à vue)', 'devient', 'nouveau(?= (?:PDG|directeur|DG|patron|président|CEO))', 'nouvelle(?= (?:PDG|directrice|DG|patronne|présidente|CEO))',
    )),
    negation: latin("dément|ne (?:va pas )?démissionner(?:a)? pas|ne démissionne(?:ra)? pas|ne quittera pas|exclut de (?:démissionner|partir)|refuse de (?:démissionner|partir)|appel(?:le)?s? à la démission|réclame(?:nt)? (?:la |sa )?démission"),
  },
  zh: {
    role: plain('首席执行官|首席執行官|首席财务官|首席財務官|行政总裁|行政總裁|执行长|執行長|总裁|總裁|财务总监|財務總監|董事长|董事長|董事会主席|董事會主席|(?<!国家|國家)主席|创始人|創始人|创办人|創辦人|总经理|總經理|CEO|CFO|掌门人|掌門人'),
    change: plain('辞职|辭職|辞任|辭任|辞去|辭去|请辞|請辭|卸任|离任|離任|离职|離職|下台|退休|退任|引退|被捕|被抓|被拘|被带走|被帶走|被查|被逮捕|落马|任命|获任|獲任|委任|聘任|接任|接棒|接替|继任|繼任|出任|上任|履新|就任|升任|当选|當選|罢免|罷免|解职|解職|免职|免職|撤换|撤換|换帅|換帥|换人|換人'),
    alone: plain('换帅|換帥'),
    negation: plain('(?:否认|否認|辟谣|闢謠|不会|不會|未|无意|無意)[^，。；]{0,8}(?:辞|辭|卸任|离职|離職|下台|退休|被捕|被抓|被查)|(?:辞职|辭職|离职|離職|卸任|被捕|被查)[^，。；]{0,6}(?:传闻|傳聞|谣言|謠言|不实|不實)'),
  },
  he: {
    role: plain('(?<![א-ת])[והלשכמב]{0,2}(?:מנכ"ל(?:ית)?|סמנכ"לי?ת? ה?כספים|יו"ר|יושבת?[ -]ראש|מייסדת?|מנהלת? ה?כספים)(?![א-ת])'),
    change: plain('(?<![א-ת])[והש]{0,2}(?:מונה|מונתה|ימונה|תמונה|מינוי|מינתה|מינה|התפטר|התפטרה|יתפטר|תתפטר|התפטרות|התפטרותו|התפטרותה|פורש|פורשת|פרש|יפרוש|תפרוש|פרישה|פרישתו|פרישתה|עוזב|עוזבת|עזב|עזבה|יעזוב|תעזוב|עזיבה|עזיבתו|עזיבתה|פוטר|פוטרה|הודח|הודחה|הדחה|הדחתו|הדחתה|נעצר|נעצרה|מעצר|מעצרו|מעצרה|יחליף|תחליף|מחליף|מחליפה|נבחר|נבחרה|ייכנס לתפקיד|תיכנס לתפקיד|מסיים את תפקידו|מסיימת את תפקידה)(?![א-ת])'),
    negation: plain('(?:מכחיש|מכחישה|הכחיש|הכחישה)[^,;]{0,30}(?:התפטר|פריש|פורש|עזיב|הדח|מעצר)|(?<![א-ת])לא (?:יתפטר|תתפטר|יפרוש|תפרוש|יעזוב|תעזוב|התפטר|נעצר)'),
  },
  ko: {
    role: plain('대표이사|대표(?!적|팀|단|작|주자|상품|지수|발의)|최고경영자|최고재무책임자|CEO|CFO|회장|(?<!국회 ?)의장|창업자|창업주|사장(?!님)'),
    change: plain('선임|취임|내정|임명|사임|사퇴|퇴임|해임|경질|물러|구속|체포|기소|교체|승진|선출|영입|연임'),
    negation: plain('(?:사임|사퇴|퇴임|해임|교체|구속|체포)(?:설)?[^,]{0,8}(?:부인|사실무근|않|없|기각|부결)'),
  },
};

function isLeadership(text, lang) {
  if (lang === 'en') return isLeadershipEn(text);
  const lex = OTHER_LEADERSHIP[lang];
  if (lex.negation.test(text)) return false;
  if (lex.alone?.test(text)) return true;
  const find = (re) => [...text.matchAll(new RegExp(re.source, `g${re.flags}`))];
  const maxGap = lang === 'de' || lang === 'fr' ? 60 : 30;
  const changes = find(lex.change);
  return find(lex.role).some((r) => changes.some((c) => {
    const gap = c.index >= r.index ? c.index - (r.index + r[0].length) : r.index - (c.index + c[0].length);
    if (gap > maxGap) return false;
    const between = text.slice(Math.min(r.index, c.index), Math.max(r.index, c.index));
    return !/[;|；。]/.test(between);
  }));
}

// ---------------------------------------------------------------------------
// Person names (conservative: better empty than wrong)
// ---------------------------------------------------------------------------

const NAME_STOP = new Set((
  // determiners, prepositions, question words
  'the a an and or but of in on at to for with from by as is are was be been will would could may new next former ex interim acting incoming outgoing longtime veteran embattled top big why how what who when where after before amid under over into out up down off ' +
  // roles and corporate words
  'ceo cfo coo cto chief executive officer financial finance chair chairman chairwoman chairperson founder cofounder president vice director managing boss head leader board member members group holdings holding inc corp corporation company co ltd plc ag se sa motors motor electronics bank banking technologies technology tech energy capital partners airlines air pharma pharmaceuticals industries systems global international labs software services management ' +
  // verbs and headline words
  'names named naming appoints appointed appoint hires hired taps tapped picks picked promotes promoted elects elected steps step stepping stepped resigns resigned resign resignation quits quit retires retire retiring retirement leaves leave leaving exits exit departs departure ousts ousted oust fires fired sacked removed replaces replaced replace succeeds succeed successor succession arrested arrests arrest detained charged indicted jailed announces announced says said reports report reportedly sources exclusive breaking update live news fire shock surprise sudden abruptly suddenly unexpectedly officially formally immediately finally scandal probe fraud lawsuit shares stock sales profit effective today ' +
  'returns return returning takes take joins join becomes become dismissed poaches poached receives visits unveils warns wins loses gets sets plans faces seeks denies defends backs transition interim apologizes confirms reveals explains under pressure not no yes his her ' +
  // media, places, nationalities, calendar
  'reuters bloomberg times journal wall street post daily financial york united states kingdom hong kong china chinese japan japanese korea korean south north europe european israel israeli german germany french france america american british britain india indian silicon valley san francisco los angeles ' +
  'monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december ' +
  // German
  'der die das den dem des ein eine einen einem und oder von vom zum zur im am bei nach mit für auf aus über neuer neue neuen chef chefin konzern konzernchef vorstand vorstandschef aufsichtsrat finanzchef finanzvorstand gründer geschäftsführer nachfolger nachfolgerin nachfolge rücktritt abgang wechsel spitze überraschend jetzt nun doch wird tritt zurück übernimmt verlässt deutsche deutschen deutscher auto autobauer unternehmen firma aktie aktien ' +
  // French
  'le la les un une du des de et ou en au aux à pour avec sur son sa ses nouveau nouvelle ancien ancienne pdg dg directeur directrice général générale financier financière patron patronne présidente fondateur fondatrice démission départ nomination succède remplace quitte nommé nommée groupe société entreprise banque français française'
).split(' '));

const NAME_TOKEN = /^(?:[ODL]')?(?:Mc|Mac)?\p{Lu}\p{Ll}+(?:-\p{Lu}?\p{Ll}+)*$/u;
const NAME_PARTICLE = new Set(['van', 'von', 'de', 'der', 'den', 'da', 'di', 'del', 'la', 'le', 'du', 'bin', 'al']);

/** Runs of capitalised, non-stopword tokens that could be a full name. */
function nameCandidates(text) {
  const tokens = [...text.matchAll(/\p{Lu}\.|[\p{L}\p{M}\d'-]+|[^\s]/gu)].map((m) => ({ word: m[0], start: m.index, end: m.index + m[0].length }));
  const isName = (w) => NAME_TOKEN.test(w) && !w.toLowerCase().endsWith("'s") && !NAME_STOP.has(w.toLowerCase()) && !w.split('-').some((p) => NAME_STOP.has(p.toLowerCase()));
  const out = [];
  let run = [];
  const flush = () => {
    while (run.length && NAME_PARTICLE.has(run.at(-1).word)) run.pop();
    const full = run.filter((t) => NAME_TOKEN.test(t.word));
    if (full.length >= 2 && run.length <= 4) {
      out.push({ name: text.slice(run[0].start, run.at(-1).end), start: run[0].start, end: run.at(-1).end });
    }
    run = [];
  };
  for (const t of tokens) {
    if (isName(t.word) || (run.length && (/^\p{Lu}\.$/u.test(t.word) || NAME_PARTICLE.has(t.word)))) run.push(t);
    else flush();
  }
  flush();
  return out;
}

const NAME_CONTEXT = {
  en: {
    // text immediately before the name
    before: new RegExp(`(?:\\b(?:${EN_ROLE}),? |\\b(?:succeed(?:s|ed|ing)?|replac(?:es|ed|ing)|oust(?:s|ed)|arrest(?:s|ed)) )$`, 'i'),
    // appointment verb before the name; only trusted when `weakAfter` also holds
    weakBefore: /\b(?:appoint(?:s|ed)|names|named|taps|tapped|hires|hired|picks|picked|promotes|promoted|elects|fires|fired|sacks) $/i,
    weakAfter: /^(?:$|,| as\b| to (?:be|become|succeed|replace|lead|head|take)\b| (?:new |next |interim )?(?:CEO|CFO|chief|chair)| (?:after|amid|following|effective)\b)/i,
    after: new RegExp(
      '^(?:, (?:\\d{2}, )?)?(?: )?(?:(?:the )?(?:former |ex-)?(?:CEO|CFO|chairman|founder|chief executive),? )?' +
      '(?:(?:to|will|has|is|was|been|being|abruptly|suddenly|officially|reportedly|set to|expected to) )*' +
      '(?:steps? (?:down|aside)|stepped down|stepping down|resign|quits?\\b|retir|leaves?\\b|departs?\\b|exits?\\b|ousted|arrested|detained|indicted|jailed|sentenced|(?:be )?(?:fired|sacked|removed|replaced)\\b|' +
      `(?:be )?(?:named|appointed|elected|promoted(?: to)?|becomes?|succeeds?|takes? over as) (?:as )?(?:the )?(?:(?:new|next|interim) )?(?:[\\p{L}]+ )?(?:${EN_ROLE}))`,
      'iu',
    ),
  },
  de: {
    before: /(?:(?:Chef(?:in)?|CEO|CFO|Vorstandsvorsitzende[rn]?|Finanzvorstand|Gründer(?:in)?|Geschäftsführer(?:in)?),? |(?:Nachfolger(?:in)? (?:wird|ist)|folgt auf|ernennt|beruft) )$/iu,
    after: /^(?:,)? (?:tritt\b|ist zurückgetreten|wird (?:neue[rn]? )?[\p{L}-]*(?:Chef|CEO|CFO|Vorstand)|übernimmt\b|verlässt\b|folgt auf|muss gehen|verhaftet|festgenommen)/iu,
  },
  fr: {
    before: /(?:(?:PDG|P-DG|DG|CEO|patron(?:ne)?|direct(?:eur|rice) (?:général|générale|financier|financière)|fondat(?:eur|rice)),? |(?:succède à|remplace|nomme) )$/iu,
    after: /^(?:,)? (?:démissionne|quitte|(?:est )?nommée?\b|succède|remplace|prend (?:la tête|les rênes)|devient|(?:est )?(?:limogée?|évincée?|arrêtée?|interpellée?)|se retire)/iu,
  },
};

function latinPeople(text, lang) {
  const ctx = NAME_CONTEXT[lang];
  return nameCandidates(text)
    .filter(({ name, start, end }) => {
      const head = text.slice(0, start);
      const tail = text.slice(end);
      if (/^ (?:veteran|executive|alum|banker|board|firm)\b/i.test(tail)) return false;
      // "PDG de Danone Emmanuel Faber": the company cannot be told apart from the name.
      if (/ (?:de|of|chez|bei|von) $/i.test(head) && name.split(' ').length > 2) return false;
      if (ctx.before.test(head) || ctx.after.test(tail)) return true;
      return Boolean(ctx.weakBefore?.test(head) && ctx.weakAfter.test(tail));
    })
    .map((c) => c.name);
}

const ZH_SURNAME = '欧阳|歐陽|司马|王|李|张|張|刘|劉|陈|陳|杨|楊|黄|黃|赵|趙|吴|吳|周|徐|孙|孫|马|馬|朱|胡|郭|何|林|罗|羅|郑|鄭|梁|谢|謝|宋|唐|许|許|韩|韓|冯|馮|邓|鄧|曹|彭|曾|肖|萧|蕭|田|董|潘|袁|蔡|蒋|蔣|余|于|杜|叶|葉|程|魏|苏|蘇|吕|呂|丁|任|卢|盧|姚|沈|钟|鍾|姜|崔|谭|譚|陆|陸|范|汪|廖|石|金|贾|賈|夏|韦|韋|付|傅|方|白|邹|鄒|孟|熊|秦|邱|侯|江|尹|薛|阎|閻|段|雷|龙|龍|黎|史|陶|贺|賀|毛|郝|顾|顧|龚|龔|邵|万|萬|覃|钱|錢|戴|严|嚴|莫|孔|向|汤|湯|雍|俞|柳|庄|莊';
// Characters that mean the match is ordinary text, not part of a given name.
const ZH_NOT_NAME = /[任职職辞辭宣将將被公司董事长長总總裁席官管理正式接出卸离離已拟擬或又再前新兼为為的了与與和及在不未称稱表示因后後突原由层層团團集]/;

function zhPeople(text) {
  const role = OTHER_LEADERSHIP.zh.role.source;
  const verb = `(?:(?:正式|宣布|已|将|將|拟|擬|突然)*(?:${OTHER_LEADERSHIP.zh.change.source}))`;
  const name = `((?:${ZH_SURNAME})[\\u4e00-\\u9fff]{1,2}?)`;
  const patterns = [
    `(?:${role})${name}(?=${verb}|[，,。：:；\\s]|$|宣布|将|將)`,
    `(?:^|[，,。：:；\\s])${name}(?=${verb})`,
    `(?:任命|委任|聘任|选举|選舉)${name}(?=为|為|担任|擔任|出任|接任|$|[，,。])`,
    `(?:由|^)${name}(?=接任|接替|接棒|继任|繼任|出任|担任|擔任)`,
  ];
  const found = [];
  for (const source of patterns) {
    for (const m of text.matchAll(new RegExp(source, 'gu'))) {
      // The surname itself may be one of the excluded characters (任, 董).
      if (!ZH_NOT_NAME.test(m[1].slice(1))) found.push(m[1]);
    }
  }
  return found;
}

const HE_FIRST_NAMES = 'אבי|אביגדור|אברהם|אהוד|אורי|אורן|אורית|איל|אייל|איתן|איתי|אלון|אלי|אמיר|אמנון|אסף|אריאל|אריק|אפרת|בועז|ברק|גד|גדי|גיא|גלית|דב|דוד|דורון|דורית|דנה|דן|דני|דרור|הילה|זאב|חיים|חגי|טל|יאיר|יואב|יוסי|יוסף|יורם|ינאי|ראובן|שמעון|אליעזר|מנחם|חנן|אילן|אילנה|יהודה|בנימין|אבנר|גבי|מוטי|רמי|אופיר|שחר|ליאת|סיגל|לימור|הדס|רקפת|יעל|יעקב|יפתח|יצחק|ירון|כרמל|ליאור|לילך|מאיר|מיכל|מיכאל|מירב|משה|מתן|נדב|ניר|נועם|נתן|ערן|עופר|עוז|עידו|עידן|עמית|עמוס|ענת|עינת|רונן|רון|רונית|רועי|רותם|רחל|רם|רפי|שגיא|שי|שירה|שלמה|שלומי|שמואל|שרון|תומר|תמר';

function hePeople(text) {
  // Hebrew has no capitals: only accept a known first name followed by a surname.
  const re = new RegExp(`(?<![א-ת])[ול]?((?:${HE_FIRST_NAMES}) (?:(?:בן|בר|אבו|כץ) )?[א-ת][א-ת'-]{1,})(?![א-ת"])`, 'gu');
  const notSurname = /^(?:את|של|על|עם|אל|מן|כי|לא|הוא|היא|מונה|מונתה|התפטר|התפטרה|פורש|פורשת|פרש|עוזב|עוזבת|עזב|נעצר|הודח|פוטר|נבחר|יחליף|מנכ|יו|לתפקיד|למנכ|ליו)$/;
  const { role, change } = OTHER_LEADERSHIP.he;
  return [...text.matchAll(re)].map((m) => m[1]).filter((n) => {
    const last = n.split(' ').at(-1);
    return !notSurname.test(last) && !role.test(last) && !change.test(last);
  });
}

const KO_SURNAME = '김|이|박|최|정|강|조|윤|장|임|한|오|서|신|권|황|안|송|류|유|전|홍|고|문|양|손|배|백|허|남|심|노|하|곽|성|차|주|우|구|민|진|지|엄|채|원|천|방|공|현|함|변|염|여|추|도|소|석|선|설|마|길|연|위|표|명|기|반|왕|금|옥|육|인|맹|제|모|탁|국|어|은|편|용';
const KO_NOT_NAME = new Set(('이사회 이사장 신임안 후임자 전임자 현직 최고경 부회장 부사장 대표이 위원장 오너가 서울시 신세계 이마트 포스코 현대차 모비스 한국은 삼성전 신한은 하나은 우리은 국민은 한화솔 두산에 롯데쇼 유한양 대한항 동아제 고려아 남양유 오리온 코오롱 조만간 오늘부 정기주 임시주 주주들 사외이 공동대 각자대 신규선 차기대 전격사 자진사 결국사 연임안 ' +
  '장중에 이번주 최대주 전무이 상무이 지주사 노조는 정부는 검찰은 법원은 경찰은 한미약 안건을 선임안 해임안 이달말 올해말 내년초 인사에 임원들 여성최 최연소 외국인 전문가 후보자 후보로 창업주 창업자 유력후 차기회 신임대 전직대 ' +
  '한국형 한국인 제약사 건설사 증권사 보험사 은행장 유통업 전자업 반도체 자동차 조선업 항공사 통신사 게임사 방송사 신문사').split(' '));

function koPeople(text) {
  // Three-syllable names standing as their own word right next to a title.
  const role = '(?:대표이사|대표|최고경영자|CEO|CFO|회장|부회장|의장|창업자|창업주|사장|부사장)';
  const name = `((?:${KO_SURNAME})[가-힣]{2})`;
  const patterns = [
    `(?<![가-힣])${name}(?= (?:전 |신임 )?(?:[가-힣A-Za-z]{1,10} )?${role})`,
    `${role}(?:에|로)? ${name}(?=$|[\\s,·…'"]|씨|을 |를 )`,
  ];
  const found = [];
  for (const source of patterns) {
    for (const m of text.matchAll(new RegExp(source, 'gu'))) {
      const n = m[1];
      if (!KO_NOT_NAME.has(n) && !/(?:그룹|전자|지주|은행|증권|화학|건설|생명|회장|사장|대표|임원|에서|으로|에게|까지|부터)/.test(n) && !/[은는을를의에도]$/.test(n)) found.push(n);
    }
  }
  return found;
}

function extractPeople(text, lang) {
  let people;
  if (lang === 'zh') people = zhPeople(text);
  else if (lang === 'he') people = hePeople(text);
  else if (lang === 'ko') people = koPeople(text);
  else people = latinPeople(text, lang);
  return [...new Set(people)].slice(0, 4);
}

// ---------------------------------------------------------------------------
// Event types (checked in this order, after leadership)
// ---------------------------------------------------------------------------

const TYPE_ORDER = ['scandal', 'regulation', 'earnings', 'deal', 'politics', 'product'];

const TYPES = {
  en: {
    scandal: latin('scandals?|fraud(?:ulent)?|brib(?:e|es|ery|ed)|corruption|embezzl\\w+|money.laundering|insider trading|misconduct|harassment|cover-?up|whistle-?blower|data (?:breach|leak)|hack(?:ed|ers?)?|cyber-?attack|class.action|accused of|allegations?|boycott|forced labou?r|accounting irregularit\\w+|short.seller'),
    regulation: latin('regulat\\w+|antitrust|anti-trust|competition (?:watchdog|authority|commission)|watchdog|SEC|FTC|DOJ|FDA|FAA|probes?|probed|investigat\\w+|fines?|fined|penalt(?:y|ies)|sanction(?:s|ed)?|bans?|banned|lawsuits?|sues?|sued|court|judge|ruling|rules against|subpoena|recalls?|compliance|settle(?:s|d|ment)'),
    earnings: latin('earnings|quarterly|(?:first|second|third|fourth).quarter|Q[1-4]|(?:net |operating )?profits?|revenues?|guidance|outlook|forecasts?|results|EPS|dividends?|sales (?:rise|fall|jump|drop|grow|slump|beat|miss)\\w*|(?:beats?|miss(?:es|ed)?) (?:estimates|expectations)'),
    deal: latin('acqui(?:re|res|red|ring|sition|sitions)|merger|merg(?:e|es|ed|ing)|takeover|buyout|to buy|buys|stake|invests? (?:in|\\$)|investment in|partnership|partners? with|joint venture|deal|agreement|contract|IPO|spin-?off|divest\\w*|raises? \\$|funding'),
    politics: latin('tariffs?|trade war|elections?|government|parliament|congress|senate|white house|president|minister|geopolitic\\w*|export (?:controls?|curbs?|ban)|embargo|Beijing|Washington|lawmakers?|policy|subsid(?:y|ies)|war|military|diplomat\\w*'),
    product: latin('launch(?:es|ed|ing)?|unveil(?:s|ed|ing)?|introduc(?:es|ed|ing)|releas(?:es|ed|ing)|debuts?|rolls? out|new (?:product|model|chip|phone|iphone|app|feature|drug|service|vehicle|car)|patent|trial results|outage'),
  },
  de: {
    scandal: latin('\\p{L}*skandal\\p{L}*|Betrug\\p{L}*|Korruption\\p{L}*|Bestechung\\p{L}*|Untreue|Geldwäsche|Insiderhandel|Fehlverhalten|Datenleck|Hackerangriff|Cyberangriff|Vorwürfe|Vorwurf|Boykott|Bilanzfälschung'),
    regulation: latin('Kartellamt|Kartell\\p{L}*|Aufsicht(?:sbehörde)?|BaFin|Ermittlung\\p{L}*|ermittelt|Razzia|Bußgeld\\p{L}*|Strafe|Geldstrafe|Klage\\p{L}*|verklagt|Gericht\\p{L}*|Urteil|Verbot|verboten|Rückruf\\p{L}*|Regulier\\p{L}*|Sanktion\\p{L}*|Staatsanwalt\\p{L}*'),
    earnings: latin('Quartal\\p{L}*|Gewinn\\p{L}*|Verlust\\p{L}*|Umsatz\\p{L}*|Prognose\\p{L}*|Bilanz|Jahreszahlen|Ergebnis\\p{L}*|Dividende\\p{L}*|Ausblick'),
    deal: latin('Übernahme\\p{L}*|übernimmt|Fusion\\p{L}*|Beteiligung|Anteile|kauft|Kauf|Partnerschaft|Kooperation|Auftrag|Großauftrag|Vertrag|Börsengang|Investition\\p{L}*|investiert'),
    politics: latin('Zölle|Zoll\\p{L}*|Handelskrieg|Wahl(?:en|kampf)?|Regierung|Bundestag|Minister\\p{L}*|Kanzler\\p{L}*|Exportverbot|Embargo|Subvention\\p{L}*|Politik\\p{L}*|Krieg'),
    product: latin('stellt [^;|]{0,40}?vor|vorgestellt|Markteinführung|Marktstart|neue[srn]? (?:Modell|Produkt|Chip|App|Fahrzeug|Medikament)\\p{L}*|bringt [^;|]{0,40}?auf den Markt|enthüllt|Patent'),
  },
  fr: {
    scandal: latin('scandales?|fraudes?|corruption|pots?-de-vin|détournement|blanchiment|délit d\'initié|harcèlement|fuite de données|piratage|cyberattaque|accusée?s?|accusations?|boycott'),
    regulation: latin('antitrust|autorité\\p{L}*|régulat\\p{L}*|régulation|AMF|enquêtes?|perquisition\\p{L}*|amendes?|sanction\\p{L}*|procès|plaintes?|poursuites?|tribunal|justice|interdi\\p{L}*|rappels? de|condamn\\p{L}*'),
    earnings: latin('résultats|bénéfices?|pertes?|chiffre d\'affaires|trimestre|trimestriels?|semestriels?|prévisions|dividendes?|ventes|marge'),
    deal: latin('acquisition|acquiert|rachat|rachète|fusion|OPA|prise de participation|partenariat|accord|contrat|commande|introduction en bourse|investit|investissement|cession'),
    politics: latin('droits? de douane|guerre commerciale|élections?|gouvernement|ministre|parlement|Élysée|embargo|subventions?|politique|guerre'),
    product: latin('lance(?:ment)?|dévoile|présente (?:son|sa|ses) (?:nouveau|nouvelle|nouveaux)|nouveau (?:modèle|produit|service)|nouvelle (?:gamme|puce|application)|brevet'),
  },
  zh: {
    scandal: plain('丑闻|醜聞|造假|欺诈|欺詐|诈骗|詐騙|行贿|行賄|受贿|受賄|贿赂|賄賂|腐败|腐敗|贪污|貪污|洗钱|洗錢|内幕交易|內幕交易|数据泄露|數據洩露|黑客|抵制|强迫劳动|財務舞弊|财务舞弊|做空报告|暴雷|爆雷'),
    regulation: plain('监管|監管|反垄断|反壟斷|立案|调查|調查|罚款|罰款|处罚|處罰|被罚|被罰|禁令|禁售|起诉|起訴|诉讼|訴訟|法院|判决|判決|召回|证监会|證監會|市场监管总局|约谈|約談|制裁'),
    earnings: plain('财报|財報|业绩|業績|营收|營收|净利|淨利|利润|利潤|亏损|虧損|季报|季報|年报|年報|中期业绩|盈利|分红|分紅|派息|指引'),
    deal: plain('收购|收購|并购|併購|合并|合併|入股|注资|注資|投资|投資|战略合作|戰略合作|签约|簽約|订单|訂單|合资|合資|上市|融资|融資|分拆|减持|減持|增持|回购|回購'),
    politics: plain('关税|關稅|贸易战|貿易戰|大选|大選|政府|国会|國會|白宫|白宮|出口管制|实体清单|實體清單|外交部|商务部|商務部|政策|战争|戰爭|地缘|地緣'),
    product: plain('发布|發布|发佈|推出|上线|上線|新品|亮相|量产|量產|开售|開售|首发|首發|专利|專利'),
  },
  he: {
    scandal: plain('שערורי|הונאה|מרמה|שוחד|שחיתות|הלבנת הון|מידע פנים|הטרדה|דליפת מידע|פריצה|מתקפת סייבר|חשד|חשדות|חרם|פרשת'),
    regulation: plain('רגולצי|רגולטור|רשות ניירות ערך|רשות התחרות|הגבלים|חקירה|חוקר|קנס|תביעה|תובע|בית (?:ה)?משפט|פסק דין|איסור|סנקצי|ריקול|כתב אישום|הפרקליטות'),
    earnings: plain('דוחות|דו"ח|רבעון|רווח|הפסד|הכנסות|מכירות|תחזית|דיבידנד|תוצאות'),
    deal: plain('רכישה|רכישת|רוכשת|רכשה|מיזוג|השקעה|משקיעה|עסקה|עסקת|הסכם|חוזה|שותפות|שיתוף פעולה|הנפקה|אקזיט|גיוס'),
    politics: plain('מכסים|מלחמת סחר|בחירות|ממשלה|ממשלת|כנסת|שר האוצר|הבית הלבן|אמברגו|מדיניות|מלחמה|מלחמת'),
    product: plain('משיקה|השקת|השקה|חושפת|מציגה|מוצר חדש|דגם חדש|פטנט'),
  },
  ko: {
    scandal: plain('스캔들|비리|분식|사기|뇌물|횡령|배임|돈세탁|내부자 ?거래|갑질|성추행|성희롱|유출|해킹|의혹|불매'),
    regulation: plain('규제|공정위|공정거래|금감원|금융위|조사|수사|압수수색|과징금|벌금|제재|소송|고발|법원|판결|판매 ?금지|리콜|반독점'),
    earnings: plain('실적|영업이익|순이익|매출|영업손실|적자|흑자|분기|어닝|배당|전망치|가이던스'),
    deal: plain('인수|합병|지분|투자|계약|수주|협력|제휴|합작|상장|매각|자사주'),
    politics: plain('관세|무역전쟁|선거|정부|국회|대통령|장관|백악관|수출 ?통제|보조금|정책|전쟁'),
    product: plain('출시|공개|선보|신제품|신차|양산|론칭|런칭|특허'),
  },
};

// ---------------------------------------------------------------------------
// Sentiment
// ---------------------------------------------------------------------------

const SENTIMENT = {
  en: [
    [0.8, latin('surg(?:e|es|ed|ing)|soar(?:s|ed|ing)?|skyrocket\\w*|record (?:high|profit|revenue|sales|quarter)|breakthrough')],
    [0.5, latin('jump(?:s|ed)?|rall(?:y|ies|ied)|beats?|upgrade[sd]?|wins?|won|boost(?:s|ed)?|outperform\\w*|strong|stronger|approv(?:es|ed|al)|success(?:ful)?|raises? (?:guidance|outlook|forecast|dividend)|cleared|exonerated')],
    [0.3, latin('ris(?:e|es|ing)|rose|gain(?:s|ed)?|grow(?:s|th|ing)?|grew|climb(?:s|ed)?|up|profit(?:able)?|partnership|expand(?:s|ed)?|launch(?:es|ed)?|unveil(?:s|ed)?|record|improv\\w+|recover\\w*|innovati\\w+')],
    [0.1, latin('appoint(?:s|ed|ment)|promot(?:es|ed)')],
    [-0.3, latin('fall(?:s|ing)?|fell|drop(?:s|ped)?|declin(?:e|es|ed|ing)|slip(?:s|ped)?|down|delay(?:s|ed)?|concerns?|risks?|pressure|probes?|probed|investigat\\w+|weak(?:er|ness)?|resign(?:s|ed|ation)?|steps? down|stepping down|quits?|uncertainty')],
    [-0.5, latin('slump(?:s|ed)?|sink(?:s)?|sank|tumbl(?:e|es|ed|ing)|miss(?:es|ed)?|downgrade[sd]?|loss(?:es)?|cuts?|layoffs?|lay(?:s|ing)? off|laid off|recalls?|fine[ds]?|penalty|lawsuit|sue[sd]?|ban(?:s|ned)?|warn(?:s|ed|ing)|sanction\\w*|ouste[dr]|ousts?|fired|sacked|forced out|breach|hack(?:ed)?|outage|boycott|halt(?:s|ed)?|strike|allegations?|accused|antitrust')],
    [-0.8, latin('plung(?:e|es|ed|ing)|crash(?:es|ed|ing)?|collaps(?:e|es|ed|ing)|scandals?|fraud(?:ulent)?|brib\\w+|corruption|embezzl\\w+|arrest(?:s|ed)?|indict\\w+|jailed|bankrupt\\w*|crisis|guilty|convicted|money.laundering')],
  ],
  de: [
    [0.7, latin('Rekord\\p{L}*|Höhenflug|Durchbruch|Kurssprung')],
    [0.4, latin('steig\\p{L}*|stieg|Plus|Gewinnsprung|wächst|Wachstum|legt zu|übertrifft|Erfolg\\p{L}*|erfolgreich|Großauftrag|Zulassung|hebt Prognose an|Aufschwung|stark\\p{L}*')],
    [-0.4, latin('sinkt|sank|fällt|Minus|Verlust\\p{L}*|Rückgang|Warnung|warnt|Klage\\p{L}*|verklagt|Rückruf\\p{L}*|Stellenabbau|streicht|Kürzung\\p{L}*|Rücktritt|Streik\\p{L}*|Ermittlung\\p{L}*|Bußgeld\\p{L}*|Strafe|Verbot|schwach\\p{L}*|Probleme')],
    [-0.8, latin('Kurssturz|Absturz|stürzt ab|bricht ein|Einbruch|\\p{L}*skandal\\p{L}*|Betrug\\p{L}*|Korruption\\p{L}*|Insolvenz\\p{L}*|Krise|verhaftet|festgenommen|Razzia')],
  ],
  fr: [
    [0.7, latin('record|envolée|s\'envole|bondit|percée')],
    [0.4, latin('hausse|progresse|grimpe|croissance|gagne|succès|dépasse|bénéfices? en hausse|relève|approbation|décroche|solide')],
    [-0.4, latin('baisse|recul(?:e)?|chute|perd|pertes?|avertissement|plaintes?|poursuites?|rappels?|suppressions? (?:de postes|d\'emplois)|licenciements?|démission\\p{L}*|grève|enquête|amende|interdiction|difficultés|inquiétudes')],
    [-0.8, latin('plonge|effondrement|s\'effondre|krach|scandales?|fraude|corruption|faillite|crise|arrêtée?|arrestation|condamnée?|perquisition')],
  ],
  zh: [
    [0.8, plain('暴涨|暴漲|飙升|飆升|大涨|大漲|创新高|創新高|新高|涨停|漲停|突破')],
    [0.4, plain('上涨|上漲|增长|增長|盈利|超预期|超預期|获批|獲批|中标|中標|扭亏|扭虧|利好|回升|上调|上調|成功|合作')],
    [-0.4, plain('下跌|下滑|亏损|虧損|减持|減持|裁员|裁員|下调|下調|不及预期|不及預期|召回|调查|調查|罚款|罰款|被罚|被罰|起诉|起訴|辞职|辭職|风险|風險|警告|利空|承压')],
    [-0.8, plain('暴跌|大跌|重挫|崩盘|崩盤|跌停|丑闻|醜聞|造假|欺诈|欺詐|行贿|受贿|受賄|腐败|腐敗|破产|破產|违约|違約|爆雷|暴雷|被捕|被抓|被带走|立案')],
  ],
  he: [
    [0.7, plain('זינוק|מזנק|זינקה|שיא|פריצת דרך')],
    [0.4, plain('עליה|עלייה|עולה|צמיחה|רווח|הצלחה|זכתה|אישור|משדרג')],
    [-0.4, plain('ירידה|יורד|ירדה|הפסד|פיטורים|פיטורי|מקצצ|אזהרה|תביעה|קנס|חקירה|התפטר|עיכוב|חשש')],
    [-0.8, plain('צניחה|צונח|צנחה|קריסה|קורס|שערורי|הונאה|שוחד|שחיתות|פשיטת רגל|משבר|נעצר|מעצר|כתב אישום')],
  ],
  ko: [
    [0.8, plain('급등|폭등|신고가|사상 ?최대|돌파|상한가')],
    [0.4, plain('상승|증가|흑자|호실적|수주|승인|성장|개선|상향|성공|협력')],
    [-0.4, plain('하락|감소|적자|손실|리콜|조사|과징금|벌금|소송|감원|구조조정|하향|우려|경고|사임|사퇴|지연|파업')],
    [-0.8, plain('급락|폭락|하한가|스캔들|비리|횡령|배임|분식|뇌물|구속|체포|파산|부도|위기|압수수색')],
  ],
};

// Negators looked up just before (and, where the grammar needs it, just after) a hit.
const NEGATION = {
  en: { before: /\b(?:not|no|never|without|denies|denied|avoids?|avoided|averts?|averted|cleared of|acquitted of|n't|fails? to|failed to)\b(?: [\p{L}'-]+){0,2} ?$|n't (?:[\p{L}'-]+ ){0,2}$/iu },
  de: { before: /(?<!\p{L})(?:nicht|kein\p{L}*|ohne|dementiert)(?: [\p{L}-]+){0,2} ?$/iu, after: /^ (?:nicht|ausgeschlossen)(?!\p{L})/iu },
  fr: { before: /(?<!\p{L})(?:pas de|sans|aucune?|dément|ne|n')(?:\s?[\p{L}'-]+){0,2}\s?$/iu, after: /^ pas(?!\p{L})/iu },
  zh: { before: /(?:不|未|没有|沒有|并无|並無|无|無|否认|否認|避免)(?:存在|会|會|被|涉)?$/u },
  he: { before: /(?<![א-ת])(?:לא|אין|ללא|בלי|מכחישה?)(?: [א-ת"'-]+)? $/u },
  ko: { after: /^(?:설| ?의혹| ?혐의)?[을를이가은는]? ?(?:없|않|아니|부인|무혐의|사실무근)/u },
};

function scoreSentiment(text, lang) {
  const neg = NEGATION[lang];
  const taken = [];
  let sum = 0;
  // Strongest first, so that "record profit" is not also counted as "profit".
  const entries = [...SENTIMENT[lang]].sort((a, b) => Math.abs(b[0]) - Math.abs(a[0]));
  for (const [weight, re] of entries) {
    for (const m of text.matchAll(new RegExp(re.source, `g${re.flags}`))) {
      const start = m.index;
      const end = start + m[0].length;
      if (taken.some(([s, e]) => start < e && end > s)) continue;
      taken.push([start, end]);
      const negated = neg.before?.test(text.slice(Math.max(0, start - 30), start))
        || neg.after?.test(text.slice(end, end + 15));
      // A negated statement is weaker than its opposite ("no fraud" is not great news).
      sum += negated ? -0.4 * weight : weight;
    }
  }
  return round2(clamp(sum, -1, 1));
}

/**
 * @param {{title: string, lang?: string}} input
 * @returns {{type: string, sentiment: number, people: string[]}}
 */
export function classifyEvent({ title, lang } = {}) {
  const text = normalizeText(title);
  if (!text) return { type: 'other', sentiment: 0, people: [] };
  const code = detectLang(text, lang === 'iw' ? 'he' : lang);
  const leadership = isLeadership(text, code);
  const type = leadership ? 'leadership' : TYPE_ORDER.find((t) => TYPES[code][t].test(text)) ?? 'other';
  return {
    type,
    sentiment: scoreSentiment(text, code),
    people: leadership ? extractPeople(text, code) : [],
  };
}

// ---------------------------------------------------------------------------
// De-duplication
// ---------------------------------------------------------------------------

const DEDUPE_WINDOW = 3 * DAY;
const DEDUPE_STOP = new Set('a an the of to in on for and or as at by with from is are its his her after amid says der die das und le la les de des du et'.split(' '));

function comparableTitle(event) {
  let t = normalizeText(event.title);
  // Aggregators append the publisher: "Headline - Reuters", "标题_新浪财经".
  const source = String(event.source || '').trim();
  if (source && t.toLowerCase().endsWith(source.toLowerCase())) t = t.slice(0, -source.length).replace(/[\s\-–—|_]+$/, '');
  const stripped = t.replace(/\s+[-–—|]\s+[^-–—|]{2,40}$|\s*[_|｜][^_|｜]{2,15}$/u, '');
  if (stripped.length >= 12) t = stripped;
  return t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function titleTokens(normalized) {
  const tokens = new Set();
  for (const word of normalized.split(' ')) {
    if (/[一-鿿]/.test(word)) {
      if (word.length === 1) tokens.add(word);
      for (let i = 0; i < word.length - 1; i += 1) tokens.add(word.slice(i, i + 2));
    } else if (word && !DEDUPE_STOP.has(word)) tokens.add(word);
  }
  return tokens;
}

function isNearDuplicate(a, b) {
  if (Math.abs((a.time || 0) - (b.time || 0)) > DEDUPE_WINDOW) return false;
  if (a.key && a.key === b.key) return true;
  // Different figures or opposite tone mean different news, however similar the wording.
  if (a.numbers !== b.numbers || a.sentiment * b.sentiment < 0) return false;
  let shared = 0;
  for (const token of a.tokens) if (b.tokens.has(token)) shared += 1;
  const smaller = Math.min(a.tokens.size, b.tokens.size);
  if (!smaller) return false;
  const jaccard = shared / (a.tokens.size + b.tokens.size - shared);
  return jaccard >= 0.7 || (smaller >= 6 && shared / smaller >= 0.85);
}

/**
 * Removes repeats of the same story, keeping the earliest report. Input order is preserved.
 * @template {{title: string, time?: number, url?: string, source?: string, sentiment?: number}} E
 * @param {E[]} events
 * @returns {E[]}
 */
export function dedupeEvents(events) {
  const items = (events || [])
    .map((event, index) => {
      const key = comparableTitle(event);
      return {
        event,
        index,
        key,
        time: event.time,
        url: event.url,
        sentiment: Number(event.sentiment) || 0,
        numbers: (key.match(/\d+/g) || []).sort().join(','),
        tokens: titleTokens(key),
      };
    })
    .sort((a, b) => (a.time || 0) - (b.time || 0) || a.index - b.index);
  const kept = [];
  const urls = new Set();
  for (const item of items) {
    if (item.url && urls.has(item.url)) continue;
    const original = kept.find((other) => isNearDuplicate(item, other));
    if (original) {
      if (item.event.source) original.outlets.add(item.event.source);
      continue;
    }
    if (item.url) urls.add(item.url);
    item.outlets = new Set(item.event.source ? [item.event.source] : []);
    kept.push(item);
  }
  return kept
    .sort((a, b) => a.index - b.index)
    // `outlets` is present only when several sources carried the same story.
    .map(({ event, outlets }) => (outlets.size > 1 ? { ...event, outlets: outlets.size } : event));
}

// ---------------------------------------------------------------------------
// Price reaction
// ---------------------------------------------------------------------------

/**
 * Move from the last close before the event to the first close after it.
 * Abnormal move = stock move minus benchmark move over the same trading dates.
 * Returns nulls while the closing price after the event is not yet known.
 *
 * @param {{t: number, c: number}[]} history ascending daily bars
 * @param {{t: number, c: number}[]} benchmarkHistory
 * @param {number} eventTimeMs
 * @param {number} [nowMs]
 */
export function priceReaction(history, benchmarkHistory, eventTimeMs, nowMs = Date.now()) {
  const none = { priceMovePct: null, abnormalMovePct: null };
  if (!Number.isFinite(eventTimeMs)) return none;
  const bars = withCloseTimes(history);
  const afterIndex = bars.findIndex((b) => b.closeAt > eventTimeMs);
  if (afterIndex <= 0) return none;
  const before = bars[afterIndex - 1];
  const after = bars[afterIndex];
  if (after.closeAt > nowMs) return none;
  if (eventTimeMs - before.closeAt > MAX_GAP || after.closeAt - eventTimeMs > MAX_GAP) return none;
  const move = (after.c / before.c - 1) * 100;

  const bench = withCloseTimes(benchmarkHistory);
  const benchBefore = bench.find((b) => b.day === before.day);
  const benchAfter = bench.find((b) => b.day === after.day);
  const abnormal = benchBefore && benchAfter && benchAfter.closeAt <= nowMs
    ? round2(move - (benchAfter.c / benchBefore.c - 1) * 100)
    : null;
  return { priceMovePct: round2(move), abnormalMovePct: abnormal };
}

// ---------------------------------------------------------------------------
// Reputation score
// ---------------------------------------------------------------------------

const MAX_AGE = 90 * DAY;

/**
 * score = 50 + 50 * sum(w * sentiment) / (sum(w) + PRIOR_WEIGHT)
 * w = type * source * corroboration * 0.5 ^ (age / half-life of the type)
 */
function scoreAt(events, nowMs) {
  const used = [];
  events.forEach((event, index) => {
    const age = nowMs - event?.time;
    if (!(age >= 0 && age <= MAX_AGE)) return;
    used.push({
      eventId: event.id ?? event.url ?? String(index),
      weight: evidenceWeight(event, age),
      sentiment: clamp(Number(event.sentiment) || 0, -1, 1),
    });
  });
  const total = used.reduce((sum, u) => sum + u.weight, PRIOR_WEIGHT);
  const impacts = used.map((u) => ({ eventId: u.eventId, impact: (50 * u.weight * u.sentiment) / total }));
  const score = clamp(50 + impacts.reduce((sum, i) => sum + i.impact, 0), 0, 100);
  return { score: Math.round(score), impacts, sample: used.length, ...scoreUncertainty(used) };
}

function labelFor(score) {
  if (score >= 65) return 'Positive';
  if (score >= 55) return 'Leaning positive';
  if (score > 45) return 'Neutral';
  if (score > 35) return 'Leaning negative';
  return 'Negative';
}

/**
 * @param {{id?: string, time: number, type?: string, sentiment?: number}[]} events
 * @param {number} nowMs
 * @returns {{score: number, trend: number, label: string, drivers: {eventId: string, impact: number}[], sample: number, margin: number|null, confidence: number}}
 *   `impact` is in score points; `trend` is 0 when there is nothing to compare with.
 */
export function reputationScore(events, nowMs) {
  const list = events || [];
  const current = scoreAt(list, nowMs);
  const previous = scoreAt(list, nowMs - 7 * DAY);
  const drivers = current.impacts
    .map((i) => ({ eventId: i.eventId, impact: round2(i.impact) }))
    .filter((i) => i.impact !== 0)
    .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))
    .slice(0, 5);
  return {
    score: current.score,
    trend: current.sample && previous.sample ? current.score - previous.score : 0,
    label: current.sample ? labelFor(current.score) : 'No data',
    drivers,
    sample: current.sample,
    margin: current.sample ? current.margin : null,
    confidence: current.sample ? current.confidence : 0,
  };
}

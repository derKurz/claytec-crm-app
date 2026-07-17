/* ============================================================
   Claytec CRM — Kontakt-Parser aus E-Mail/Text
   1:1-Portierung von contact_parser.py (OneNote-Kontakte-Tool).
   Erkennt Firma, Name, Funktion, akad. Titel, Adresse, E-Mails,
   Telefon/Mobil, Website/Social aus eingefügtem Signatur-/E-Mail-Text.
   ============================================================ */
var CRM = window.CRM || {};
window.CRM = CRM;

CRM.emailParser = {};

CRM.emailParser.COMPANY_INDICATORS = [
  'GmbH', 'AG', 'KG', 'OHG', 'UG', 'e.V.', 'eG', 'e.G.', 'IB', 'GbR', 'mbH', 'Inc', 'Ltd', 'LLC',
  'Büro', 'Architektur', 'Ingenieurbüro', 'Planungsbüro', 'Bauzentrum', 'Bauunternehmen',
  'Bau', 'Baugesellschaft', 'Baustoffe', 'Naturbaustoffe', 'Baustoffhandel',
  'Immobilien', 'Consulting', 'Partner', 'Group', 'Gruppe',
  'Zentrum', 'Institut', 'Praxis', 'Kanzlei', 'Studio', 'Atelier', 'Werkstatt',
  'Service', 'Solutions', 'Systems', 'Technologies', 'Tech', 'Digital', 'Handels',
];

CRM.emailParser.CRAFT_JOBS = [
  'malermeister', 'maler', 'schreinermeister', 'schreiner', 'tischlermeister', 'tischler',
  'elektrikermeister', 'elektriker', 'installateur', 'installateurmeister',
  'maurermeister', 'maurer', 'zimmermeister', 'zimmerer', 'dachdecker', 'dachdeckermeister',
  'fliesenleger', 'fliesenlegermeister', 'glaser', 'glasermeister',
  'metallbauer', 'metallbauermeister', 'schlosser', 'schlossermeister',
];

CRM.emailParser.TITLE_KEYWORDS = [
  'leitung', 'leiter', 'leiterin', 'führer', 'führerin', 'geschäftsführer', 'geschäftsführerin',
  'chef', 'chefin', 'direktor', 'direktorin', 'vorstand', 'vorständ', 'inhaber', 'inhaberin',
  'chief', 'officer', 'executive', 'ceo', 'cfo', 'cto', 'coo', 'cio',
  'manager', 'managerin', 'management',
  'assistent', 'assistentin', 'assistenz', 'sekretär', 'sekretärin',
  'koordinator', 'koordinatorin', 'koordination',
  'teamleiter', 'teamleiterin', 'abteilungsleiter', 'abteilungsleiterin',
  'bereichsleiter', 'bereichsleiterin', 'gruppenleiter', 'gruppenleiterin',
  'projektleiter', 'projektleiterin', 'projektmanager', 'projektmanagerin',
  'projektsteuerung', 'projektsteuerer',
  'ingenieur', 'ingenieurin', 'techniker', 'technikerin', 'meister', 'meisterin',
  'architekt', 'architektin', 'planer', 'planerin',
  'bauleiter', 'bauleiterin', 'bauleitung', 'oberbauleiter', 'polier',
  'kalkulator', 'kalkulatorin', 'kalkulation', 'arbeitsvorbereitung', 'abrechnung',
  'berater', 'beraterin', 'consultant', 'beratung',
  'sachbearbeiter', 'sachbearbeiterin', 'sachbearbeitung', 'mitarbeiter', 'mitarbeiterin',
  'referent', 'referentin', 'gesellschafter', 'gesellschafterin', 'partner', 'partnerin',
  'verkauf', 'verkäufer', 'verkäuferin', 'vertrieb', 'vertriebs',
  'innendienst', 'außendienst', 'aussendienst', 'sales', 'account', 'key account',
  'einkauf', 'einkäufer', 'einkäuferin', 'beschaffung',
  'verwaltung', 'administration', 'büro', 'buchhaltung', 'buchhalter', 'buchhalterin',
  'controller', 'controlling', 'finanzen', 'finanz',
  'personal', 'personalabteilung', 'hr', 'human resources',
  'produktion', 'fertigung', 'montage', 'werkstatt', 'schlosser', 'schweißer',
  'qualität', 'qualitäts', 'prüfung', 'prüfer',
  'logistik', 'lager', 'versand', 'disposition', 'disponent',
  'entwickler', 'entwicklerin', 'programmierer', 'programmiererin', 'entwicklung', 'softwareentwicklung',
  'administrator', 'administratorin', 'support', 'marketing', 'werbung', 'kommunikation',
  'jurist', 'juristin', 'rechtsanwalt', 'rechtsanwältin',
  'empfang', 'rezeption', 'rezeptionist', 'rezeptionistin', 'hausmeister', 'hausmeisterin', 'facility',
  'auszubildender', 'auszubildende', 'azubi', 'lehrling', 'praktikant', 'praktikantin', 'praktikum',
  'trainee', 'volontär', 'volontärin', 'werkstudent', 'werkstudentin', 'student', 'studentin',
];

/* ---------- kleine Python-Äquivalente ---------- */
function isUpperStr(s) { return s === s.toUpperCase() && s !== s.toLowerCase(); }
function isLowerStr(s) { return s === s.toLowerCase() && s !== s.toUpperCase(); }
function capitalizeWord(w) { return w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w; }
function splitWs(s) { return s.trim().split(/\s+/).filter(Boolean); }

CRM.emailParser.parse = function (rawText) {
  const EP = CRM.emailParser;
  const data = {
    company: '', name: '', title: '', academic_title: '',
    street: '', postal: '', city: '', email: '', email2: '',
    phone_mobile: '', phone_work: '', website: '', social: '',
  };

  const text = String(rawText || '').replace(/\|/g, ' ');
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l);

  const emailsFound = [];
  const phonesFound = []; // [type, number]

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLower = line.toLowerCase();

    if (line.indexOf('@') !== -1) {
      const ms = line.match(/[\w.-]+@[\w.-]+\.\w+/g) || [];
      ms.forEach((em) => { if (emailsFound.indexOf(em) === -1) emailsFound.push(em); });
    }

    if (/(www\.|http)/.test(lineLower) && !data.website) {
      if (lineLower.indexOf('instagram.com') === -1 && lineLower.indexOf('facebook.com') === -1 && lineLower.indexOf('linkedin.com') === -1) {
        const wm = line.match(/(https?:\/\/[^\s]+|www\.[^\s]+)/i);
        if (wm) data.website = wm[0];
      }
    }
    if (/(instagram\.com|facebook\.com|linkedin\.com|twitter\.com|xing\.com)/.test(lineLower) && !data.social) {
      const sm = line.match(/(https?:\/\/[^\s]+|www\.[^\s]+)/i);
      if (sm) data.social = sm[0];
    }

    // PLZ / Stadt / Straße
    if (!data.postal) {
      const addrMatch = line.match(/^([A-ZÄÖÜ][a-zäöüß\-]+(?:\s+[A-ZÄÖÜ]?[a-zäöüß\-]+)*)\s+(\d+[a-z]?)\s*[-–]\s*(\d{5})\s+([A-ZÄÖÜ][a-zäöüßA-Z\-]+(?:\s+[A-ZÄÖÜ]?[a-zäöüß\-]+)*)/);
      if (addrMatch) {
        data.street = addrMatch[1] + ' ' + addrMatch[2];
        data.postal = addrMatch[3];
        let cityRaw = addrMatch[4];
        let cityClean = cityRaw.split(/[/,]/)[0].trim();
        data.city = isUpperStr(cityClean) ? capitalizeWord(cityClean) : cityClean;
        continue;
      }
      const plzMatch = line.match(/(?:[dD][\s\-]+)?(\d{5})\s+([A-ZÄÖÜ][a-zäöüßA-Z\-]+(?:\s+[A-ZÄÖÜ]?[a-zäöüß\-]+)*(?:[/,\s]+[A-ZÄÖÜ][a-zäöüß\s]+)?)/);
      if (plzMatch) {
        data.postal = plzMatch[1];
        let cityRaw = plzMatch[2];
        let cityClean = cityRaw.split(/[/,]/)[0].trim();
        data.city = isUpperStr(cityClean) ? capitalizeWord(cityClean) : cityClean;
        let streetInLine = line.slice(0, line.indexOf(plzMatch[1])).trim();
        streetInLine = streetInLine.replace(/^[dD][\s\-]+/, '').trim();
        streetInLine = streetInLine.replace(/^Standort\s+\w+\s*/i, '').trim();
        streetInLine = streetInLine.replace(/\s*[-–]\s*$/, '').trim();
        if (streetInLine && /\d+/.test(streetInLine)) data.street = streetInLine;
      }
    }
    if (!data.street) {
      const streetMatch = line.match(/^([A-ZÄÖÜ][a-zäöüßA-Z\-]+(?:\s+[A-ZÄÖÜ]?[a-zäöüß\-]+)*(?:str\.?|straße|strasse|weg|platz|allee|gasse)?)\s+(\d+[a-z]?(?:\s*[-–]\s*\d+[a-z]?)?)$/i);
      if (streetMatch) data.street = line;
    }

    // Telefon T/F/M
    if (/[tfm]\s+[\+\d]/.test(lineLower)) {
      (lineLower.match(/t\s+([\+\d][\d\s\(\)\/\-]{5,})/g) || []).forEach((m) => {
        const v = m.replace(/^t\s+/, '').trim(); phonesFound.push(['work', v]);
      });
      (lineLower.match(/m\s+([\+\d][\d\s\(\)\/\-]{5,})/g) || []).forEach((m) => {
        const v = m.replace(/^m\s+/, '').trim(); phonesFound.push(['mobile', v]);
      });
      continue;
    }
    if (lineLower.indexOf('f ') === 0 || lineLower.indexOf('fax') === 0 || lineLower.indexOf('telefax') !== -1) continue;
    if (lineLower.indexOf('t ') === 0 || lineLower.indexOf('telefon:') !== -1 || lineLower.indexOf('telefon ') === 0 || (lineLower.indexOf('tel') === 0 && line.indexOf(':') !== -1)) {
      const pm = line.match(/[\+\d][\d\s\(\)\/\-]{5,}/);
      if (pm) phonesFound.push(['work', pm[0].trim()]);
      continue;
    }
    if (lineLower.indexOf('m ') === 0 || lineLower.indexOf('mobil:') !== -1 || lineLower.indexOf('mobil ') === 0 || lineLower.indexOf('handy') === 0) {
      const pm = line.match(/[\+\d][\d\s\(\)\/\-]{5,}/);
      if (pm) phonesFound.push(['mobile', pm[0].trim()]);
      continue;
    }
    if (!/^\d{1,3}\s*[-–]\s*\d{5}(?:\s|$)/.test(line) && !/\d{5}\s+[A-ZÄÖÜ]/.test(line)) {
      const pms = line.match(/[\+\d][\d\s\(\)\/\-]{5,}/g) || [];
      pms.forEach((phone) => {
        const cleaned = phone.replace(/[^\d\+\s\(\)\/\-]/g, '').trim();
        if (cleaned && cleaned.replace(/[^\d]/g, '').length >= 6) phonesFound.push(['unknown', cleaned]);
      });
    }
  }

  // E-Mails sortieren (persönliche zuerst)
  if (emailsFound.length) {
    const personal = [], generic = [];
    const genericWords = ['info', 'kontakt', 'office', 'mail', 'post', 'verwaltung', 'buero'];
    emailsFound.forEach((email) => {
      const local = email.split('@')[0].toLowerCase();
      if ((local.indexOf('.') !== -1 || local.indexOf('-') !== -1) && !genericWords.some((g) => local.indexOf(g) !== -1)) personal.push(email);
      else generic.push(email);
    });
    const sorted = personal.concat(generic);
    if (sorted.length >= 1) data.email = sorted[0];
    if (sorted.length >= 2) data.email2 = sorted[1];
  }

  // Telefon zuordnen — unbeschriftete Nummern an der Vorwahl erkennen:
  // 015x/016x/017x (auch als +49 15x...) ist Mobil, alles andere Festnetz.
  const isMobileNum = (n) => {
    const d = String(n).replace(/[^\d+]/g, '').replace(/^\+49/, '0').replace(/^0049/, '0');
    return /^01[567]/.test(d);
  };
  let mobilePhone = null, workPhone = null;
  phonesFound.forEach(([t, n]) => {
    if (t === 'unknown') t = isMobileNum(n) ? 'mobile' : 'work';
    if (t === 'mobile' && !mobilePhone) mobilePhone = n;
    else if (t === 'work' && !workPhone) workPhone = n;
  });
  if (mobilePhone) data.phone_mobile = mobilePhone;
  if (workPhone) data.phone_work = workPhone;

  // Grußformeln / Anreden, die nie Name/Firma sind (Verbesserung ggü. Original)
  const GREETINGS = [
    'mit freundlichen grüßen', 'mit freundlichem gruß', 'freundliche grüße', 'beste grüße',
    'viele grüße', 'herzliche grüße', 'schöne grüße', 'liebe grüße', 'mit besten grüßen',
    'mfg', 'lg', 'vg', 'sehr geehrte', 'sehr geehrter', 'guten tag', 'guten morgen',
    'hallo', 'ihr team', 'i. a.', 'i.a.', 'i. v.', 'i.v.', 'gesendet von',
  ];
  const isGreeting = (line) => {
    const ll = line.toLowerCase().replace(/[,!.]/g, '').trim();
    return GREETINGS.some((g) => ll === g || ll.indexOf(g) === 0);
  };

  // Textzeilen (ohne strukturierte Daten)
  const textLines = [];
  lines.forEach((line) => {
    const ll = line.toLowerCase();
    const isStructural = isGreeting(line)
      || line.indexOf('@') !== -1
      || /(www\.|http|instagram\.com|facebook\.com)/.test(ll)
      || /(?:D[\s\-])?\d{5}\s+[A-ZÄÖÜ]/i.test(line)
      || /[\+\d][\d\s\(\)\/\-]{7,}/.test(line)
      || ll.indexOf('telefon:') === 0 || ll.indexOf('e-mail:') === 0
      || ll.indexOf('tel') === 0 || ll.indexOf('fax') === 0
      || ll.indexOf('t ') === 0 || ll.indexOf('f ') === 0 || ll.indexOf('m ') === 0
      || (data.street && line === data.street);
    if (!isStructural && line) {
      const cleaned = line.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
      if (cleaned) textLines.push(cleaned);
    }
  });

  // Klassifizierung Firma/Name/Funktion/Titel.
  // WICHTIG: Wort-genau vergleichen, nicht als Teilstring — sonst „findet"
  // z.B. das Stichwort „hr" den Nachnamen „Mehringer" und ein Name landet
  // als Funktion (real passiert). Kurze Stichwörter (≤4 Zeichen) müssen
  // exakt als Wort vorkommen; längere dürfen in Komposita stecken
  // (z.B. „berater" in „Verkaufsberater").
  const tokensLower = (line) => line.toLowerCase().split(/[^a-zäöüß0-9]+/).filter(Boolean);
  const isJobTitle = (line) => {
    const ll = line.toLowerCase();
    const toks = tokensLower(line);
    return EP.TITLE_KEYWORDS.some((k) => {
      if (k.indexOf(' ') !== -1) return ll.indexOf(k) !== -1; // Mehrwort („key account")
      if (k.length <= 4) return toks.indexOf(k) !== -1;
      return toks.some((t) => t.indexOf(k) !== -1);
    });
  };
  const isCompanyName = (line) => {
    // Rechtsformen/Branchen-Wörter: exakt als Wort (Groß-/Kleinschreibung zählt,
    // damit „AG" nicht in „Baugefühl" o.ä. anschlägt); ab 6 Zeichen auch als
    // Wortanfang („Baugesellschaft" in „Baugesellschaften").
    const rawToks = line.split(/[^A-Za-zÄÖÜäöüß0-9.]+/).filter(Boolean).map((t) => t.replace(/\.+$/, ''));
    const hit = EP.COMPANY_INDICATORS.some((ind) => {
      const indClean = ind.replace(/\./g, '');
      return rawToks.some((t) => {
        const tClean = t.replace(/\./g, '');
        if (tClean === indClean) return true;
        return indClean.length >= 6 && tClean.indexOf(indClean) === 0;
      });
    });
    if (hit) return true;
    if (['Architekten', 'Ingenieure', 'Planer', 'Berater'].some((s) => line.endsWith(s))) return true;
    const words = splitWs(line);
    if (words.length === 3) {
      const last = words[words.length - 1].toLowerCase();
      if (EP.CRAFT_JOBS.some((c) => last.indexOf(c) === 0)) return true;
    }
    if (words.length === 1 && isUpperStr(line) && line.length > 2) return true;
    return false;
  };
  // Werbeslogans wie „Immer ein gutes Baugefühl": mehrere kleingeschriebene
  // Füllwörter mitten in der Zeile — nie Firma, nie Name, nie Funktion.
  const isSlogan = (line) => {
    const words = splitWs(line);
    if (words.length < 3) return false;
    const lower = words.slice(1).filter((w) => isLowerStr(w[0])).length;
    return lower >= 2 && !isCompanyName(line);
  };
  const isAcademicTitle = (line) => {
    const inds = ['Prof.', 'Dipl.', 'Dr.', 'Ing.', 'Architekt', 'Stadtplaner', 'BDA', 'M.Sc.', 'B.Sc.', 'M.A.', 'B.A.'];
    if (!inds.some((ind) => line.indexOf(ind) !== -1)) return false;
    const wordsWoDots = splitWs(line).filter((w) => !w.endsWith('.') && /^[a-zäöüßA-ZÄÖÜ.\-]+$/.test(w) && w.replace(/[.\-]/g, '').match(/^[a-zäöüßA-ZÄÖÜ]+$/));
    const capWords = wordsWoDots.filter((w) => w && w[0] === w[0].toUpperCase() && /[A-ZÄÖÜ]/.test(w[0])).length;
    if (capWords >= 2) return false;
    return true;
  };
  const isPersonName = (line) => {
    const words = splitWs(line);
    if (/[\d@]/.test(line)) return false;
    if (words.length > 5 || words.length < 2) return false;
    if (isCompanyName(line)) return false;
    if (isJobTitle(line)) return false;
    if (isSlogan(line)) return false;
    if (['Dipl.-Ing.', 'Dr.', 'Prof.', 'Dipl.', 'M.Sc.', 'B.Sc.'].some((t) => line.indexOf(t) !== -1)) {
      let woTitle = line;
      ['Dipl.-Ing.', 'Dr.', 'Prof.', 'Dipl.', 'M.Sc.', 'B.Sc.', 'M.A.', 'B.A.'].forEach((t) => { woTitle = woTitle.replace(t, '').trim(); });
      const rem = splitWs(woTitle);
      if (rem.length >= 1 && rem.length <= 3) return true;
    }
    // Alle Wörter müssen wie Namensbestandteile aussehen (großgeschrieben,
    // nur Buchstaben/Bindestrich; „von/zu/de..." klein erlaubt) — sonst
    // rutschen Slogan-Reste als Name durch.
    const small = ['von', 'zu', 'van', 'de', 'del', 'la', 'le', 'der'];
    const nameWords = words.filter((w) => /^[A-ZÄÖÜ][a-zäöüßA-ZÄÖÜ\-']*$/.test(w) || isUpperStr(w));
    const smallWords = words.filter((w) => small.indexOf(w.toLowerCase()) !== -1 && isLowerStr(w));
    if (nameWords.length + smallWords.length !== words.length) return false;
    return nameWords.length >= 2;
  };
  const correctName = (name) => {
    const small = ['von', 'zu', 'van', 'de', 'del', 'la', 'le'];
    return splitWs(name).map((w) => {
      if (isUpperStr(w) || isLowerStr(w)) return small.indexOf(w.toLowerCase()) !== -1 ? w.toLowerCase() : capitalizeWord(w);
      return w;
    }).join(' ');
  };
  const correctCompany = (company) => {
    const allCaps = ['GMBH', 'AG', 'KG', 'OHG', 'UG', 'IB', 'GBR', 'MBH', 'INC', 'LTD', 'LLC', 'BDA', 'EG'];
    return splitWs(company).map((w) => {
      const wu = w.toUpperCase().replace(/\./g, '');
      if (allCaps.indexOf(wu) !== -1) {
        if (wu === 'GMBH' || wu === 'MBH') return 'GmbH';
        if (wu === 'GBR') return 'GbR';
        if (wu === 'EG') return 'eG';
        return wu;
      }
      if (isUpperStr(w)) return capitalizeWord(w);
      return w;
    }).join(' ');
  };

  let nameFound = null, companyFound = null, titleFound = null;
  for (let i = 0; i < textLines.length; i++) {
    let line = textLines[i];
    if (!line) continue;
    if (line.toLowerCase().indexOf('standort ') === 0) continue;
    if (!data.academic_title && isAcademicTitle(line)) { data.academic_title = line; continue; }

    if (!companyFound && isCompanyName(line)) {
      companyFound = line;
      const words = splitWs(line);
      if (words.length === 3 && !nameFound) {
        const last = words[words.length - 1].toLowerCase();
        if (EP.CRAFT_JOBS.some((c) => last.indexOf(c) !== -1)) nameFound = correctName(words.slice(0, 2).join(' '));
      }
      if (!nameFound && i + 1 < textLines.length) {
        const next = textLines[i + 1];
        if (next && splitWs(next).length <= 2 && !isPersonName(next) && !isJobTitle(next) && !isAcademicTitle(next)
          && next.toLowerCase().indexOf('standort') !== 0 && !/\d{5}/.test(next) && !/\d+$/.test(next)) {
          companyFound = companyFound + ' ' + next;
          textLines[i + 1] = '';
        }
      }
      continue;
    }
    if (!nameFound && isPersonName(line)) {
      let corrected = correctName(line);
      const prefixes = ['Dipl.-Ing.', 'Dr.', 'Prof.', 'Dipl.', 'M.Sc.', 'B.Sc.', 'M.A.', 'B.A.'];
      for (const p of prefixes) {
        if (corrected.indexOf(p) !== -1) { if (!data.academic_title) data.academic_title = p; corrected = corrected.replace(p, '').trim(); break; }
      }
      nameFound = corrected;
      continue;
    }
    if (isJobTitle(line)) { if (!titleFound) titleFound = line; continue; }
    if (isSlogan(line)) continue; // Werbesprüche komplett ignorieren
    if (!companyFound && line.toLowerCase().indexOf('standort') !== 0) {
      if (isCompanyName(line) || !isPersonName(line)) companyFound = line;
    }
  }

  if (nameFound) data.name = nameFound;
  if (companyFound) data.company = correctCompany(companyFound);
  if (titleFound) data.title = titleFound;
  return data;
};

/* ---------- in CRM-Kontakt umwandeln ---------- */
CRM.emailParser.toContact = function (data, type, source) {
  const c = CRM.makeEmptyContact();
  c.type = type || 'sonstige';
  c.source = source || 'eigene';
  c.firma1 = data.company || data.name || 'Neuer Kontakt';
  c.erpNr = data.erpNr || '';
  const nameParts = splitWs(data.name || '');
  if (nameParts.length >= 2) { c.ansprechpartner.name = nameParts[nameParts.length - 1]; c.ansprechpartner.vorname = nameParts.slice(0, -1).join(' '); }
  else if (nameParts.length === 1) c.ansprechpartner.name = nameParts[0];
  c.ansprechpartner.funktion = [data.academic_title, data.title].filter(Boolean).join(' - ');
  c.strasse = data.street || '';
  c.plz = data.postal || '';
  c.ort = data.city || '';
  c.telFirma = data.phone_work || '';
  c.ansprechpartner.telefon = data.phone_mobile || '';
  // persönliche Mail an Ansprechpartner, generische an Firma
  if (data.email) {
    const local = data.email.split('@')[0].toLowerCase();
    const generic = ['info', 'kontakt', 'office', 'mail', 'post', 'verwaltung', 'buero'].some((g) => local.indexOf(g) !== -1);
    if (generic) c.emailFirma = data.email; else c.ansprechpartner.email = data.email;
  }
  if (data.email2) { if (c.emailFirma) c.ansprechpartner.email = c.ansprechpartner.email || data.email2; else c.emailFirma = data.email2; }
  c.website = data.website || data.social || '';
  return c;
};

/* ============================================================
   Dialog: Aus E-Mail/Text Kontakt anlegen
   ============================================================ */
CRM.emailParser.FIELDS = [
  ['Firma', 'company'], ['ERP-/Kundennr.', 'erpNr'], ['Name', 'name'], ['Akad. Titel', 'academic_title'], ['Funktion', 'title'],
  ['Straße', 'street'], ['PLZ', 'postal'], ['Ort', 'city'],
  ['E-Mail 1', 'email'], ['E-Mail 2', 'email2'], ['Mobil', 'phone_mobile'], ['Festnetz', 'phone_work'],
  ['Website', 'website'], ['Social', 'social'],
];

CRM.emailParser.openDialog = function () {
  const typeOpts = CRM.TYPES.map((t) => `<option value="${t}">${CRM.TYPE_LABELS[t]}</option>`).join('');
  const srcOpts = CRM.SOURCES.map((s) => `<option value="${s}">${CRM.SOURCE_LABELS[s]}</option>`).join('');
  const fieldInputs = CRM.emailParser.FIELDS.map(([label, key]) =>
    `<div class="col" style="min-width:200px"><label>${label}</label><input id="ep-${key}"></div>`).join('');
  const projectOpts = CRM.db.getProjects().map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  CRM.emailParser._pendingLinks = [];
  CRM.emailParser._pendingProjectId = '';

  CRM.openModal(`
    <h2>+ Neuer Kontakt</h2>
    <p style="color:var(--text-dim);font-size:13px">E-Mail-Signatur oder Kontaktblock einfügen und „Analysieren" klicken — die Felder unten werden automatisch ausgefüllt. Geht auch ganz ohne Text: einfach die Felder unten direkt manuell ausfüllen.</p>
    <textarea id="ep-input" rows="6" placeholder="Hier den E-Mail-Text / die Signatur einfügen (Strg+V) — optional..."></textarea>
    <div class="row" style="margin:8px 0">
      <button class="btn btn-primary" onclick="CRM.emailParser.analyze()">▼ Analysieren</button>
      <button class="btn btn-sm" onclick="document.getElementById('ep-input').value=''">Leeren</button>
    </div>
    <h3 style="margin:6px 0">Erkannte Daten</h3>
    <div class="row" style="flex-wrap:wrap;gap:8px">${fieldInputs}</div>
    <div class="row" style="margin-top:10px">
      <div class="col" style="max-width:180px"><label>Kontakttyp</label><select id="ep-type">${typeOpts}</select></div>
      <div class="col" style="max-width:180px"><label>Listenquelle</label><select id="ep-source">${srcOpts}</select></div>
    </div>
    <h3 style="margin:14px 0 6px">Gleich verknüpfen (optional)</h3>
    <div class="row" style="flex-wrap:wrap;gap:8px">
      <div class="col" style="min-width:220px">
        <label>Mit Projekt verknüpfen</label>
        <select id="ep-project"><option value="">Kein Projekt</option>${projectOpts}</select>
      </div>
      <div class="col" style="min-width:260px;position:relative">
        <label>Mit Kontakt verknüpfen (Händler/Verarbeiter/Architekt)</label>
        <input id="ep-link-search" placeholder="Firma suchen...">
        <div id="ep-link-results" class="header-search-dropdown hidden"></div>
      </div>
    </div>
    <div class="li-badges" id="ep-link-chips" style="margin-top:8px"></div>
    <div class="modal-footer">
      <button class="btn" onclick="CRM.closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="CRM.emailParser.createContact()">Kontakt anlegen</button>
    </div>
  `, { dismissible: false });

  document.getElementById('ep-link-search').addEventListener('input', CRM.emailParser.renderLinkSearch);
  document.getElementById('ep-link-search').addEventListener('focus', CRM.emailParser.renderLinkSearch);
  CRM.wirePlzOrtAutofill(document.getElementById('ep-postal'), document.getElementById('ep-city'));
  if (!CRM.emailParser._outsideHandlerAttached) {
    CRM.emailParser._outsideHandlerAttached = true;
    document.addEventListener('click', (e) => {
      if (e.target.closest('#ep-link-search') || e.target.closest('#ep-link-results')) return;
      const r = document.getElementById('ep-link-results');
      if (r) r.classList.add('hidden');
    });
  }
};

CRM.emailParser.renderLinkSearch = function () {
  const input = document.getElementById('ep-link-search');
  const results = document.getElementById('ep-link-results');
  if (!input || !results) return;
  const q = input.value.trim().toLowerCase();
  if (!q) { results.classList.add('hidden'); results.innerHTML = ''; return; }
  const linked = new Set(CRM.emailParser._pendingLinks);
  const matches = CRM.db.getContacts()
    .filter((c) => ['haendler', 'verarbeiter', 'architekt'].includes(c.type) && !linked.has(c.id))
    .filter((c) => (c.firma1 + ' ' + c.ort).toLowerCase().includes(q))
    .slice(0, 8);
  results.innerHTML = matches.length
    ? matches.map((c) => `
      <div class="header-search-item" data-id="${c.id}">
        <span class="badge badge-${c.type}" style="margin-right:6px">${CRM.TYPE_SHORT[c.type] || '–'}</span>
        <strong>${esc(c.firma1)}</strong>
        <span style="color:var(--text-dim);font-size:12px"> · ${esc(c.plz)} ${esc(c.ort)}</span>
      </div>`).join('')
    : '<div class="header-search-empty">Keine Treffer</div>';
  results.querySelectorAll('.header-search-item').forEach((row) => {
    row.addEventListener('mousedown', (e) => { e.preventDefault(); CRM.emailParser.addPendingLink(row.dataset.id); });
  });
  results.classList.remove('hidden');
};

CRM.emailParser.addPendingLink = function (id) {
  if (!CRM.emailParser._pendingLinks.includes(id)) CRM.emailParser._pendingLinks.push(id);
  const input = document.getElementById('ep-link-search');
  if (input) input.value = '';
  document.getElementById('ep-link-results')?.classList.add('hidden');
  CRM.emailParser.renderLinkChips();
};

CRM.emailParser.removePendingLink = function (id) {
  CRM.emailParser._pendingLinks = CRM.emailParser._pendingLinks.filter((x) => x !== id);
  CRM.emailParser.renderLinkChips();
};

CRM.emailParser.renderLinkChips = function () {
  const el = document.getElementById('ep-link-chips');
  if (!el) return;
  el.innerHTML = CRM.emailParser._pendingLinks.map((id) => {
    const c = CRM.db.getContact(id);
    if (!c) return '';
    return `<span class="badge">${esc(c.firma1)} <span style="cursor:pointer;opacity:.7" onclick="CRM.emailParser.removePendingLink('${id}')">✕</span></span>`;
  }).join(' ');
};

CRM.emailParser.analyze = function () {
  const text = document.getElementById('ep-input').value;
  if (!text.trim()) { CRM.toast('Bitte zuerst Text einfügen.', 'error'); return; }
  const data = CRM.emailParser.parse(text);
  CRM.emailParser.FIELDS.forEach(([, key]) => {
    const el = document.getElementById('ep-' + key);
    if (el) el.value = data[key] || '';
  });
  CRM.toast('Analysiert — bitte Felder prüfen.', 'success');
};

CRM.emailParser.createContact = function () {
  const data = {};
  CRM.emailParser.FIELDS.forEach(([, key]) => { data[key] = (document.getElementById('ep-' + key) || {}).value || ''; });
  if (!data.company && !data.name) { CRM.toast('Mindestens Firma oder Name nötig.', 'error'); return; }
  const c = CRM.emailParser.toContact(data, document.getElementById('ep-type').value, document.getElementById('ep-source').value);
  // Vor dem evtl. Doppelkontakt-Dialog sichern, da der das Formular ersetzt
  CRM.emailParser._pendingProjectId = document.getElementById('ep-project')?.value || '';

  // einfache Duplikatprüfung: gleicher Firmenname (normalisiert) + gleiche PLZ
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-zäöüß0-9]/g, '');
  const dup = CRM.db.getContacts().find((x) => norm(x.firma1) === norm(c.firma1) && (!c.plz || x.plz === c.plz));
  if (dup) {
    CRM.openModal(`
      <h2>Möglicher Doppelkontakt</h2>
      <p>„<strong>${esc(c.firma1)}</strong>" (${esc(c.plz)} ${esc(c.ort)}) ähnelt einem bestehenden Kontakt:</p>
      <div class="list-item" style="cursor:default"><div class="li-main"><div class="li-title">${esc(dup.firma1)}</div><div class="li-sub">${esc(dup.plz)} ${esc(dup.ort)}</div></div></div>
      <div class="modal-footer">
        <button class="btn" onclick="CRM.openContactDetail('${dup.id}')">Bestehenden öffnen</button>
        <button class="btn btn-primary" onclick='CRM.emailParser._forceAdd(${JSON.stringify(c).replace(/'/g, "&#39;")})'>Trotzdem neu anlegen</button>
      </div>
    `);
    return;
  }
  CRM.emailParser._forceAdd(c);
};

CRM.emailParser._forceAdd = function (c) {
  const saved = CRM.db.addContact(c);
  if (CRM.emailParser._pendingProjectId) CRM.linkContactToProject(saved.id, CRM.emailParser._pendingProjectId);
  (CRM.emailParser._pendingLinks || []).forEach((linkId) => CRM.linkContacts(saved.id, linkId));
  const linkCount = (CRM.emailParser._pendingProjectId ? 1 : 0) + (CRM.emailParser._pendingLinks || []).length;
  CRM.emailParser._pendingLinks = [];
  CRM.emailParser._pendingProjectId = '';
  CRM.toast(linkCount ? `Kontakt angelegt und ${linkCount} Verknüpfung(en) gesetzt.` : 'Kontakt angelegt.', 'success');
  CRM.renderContactList();
  CRM.openContactDetail(saved.id);
  if (CRM.geocoding && CRM.geocoding.geocodeSingle) CRM.geocoding.geocodeSingle(saved.id);
  // vCard automatisch im Kundenordner ablegen (nur am Laptop mit
  // verbundenem Claytec-Ordner; sonst still — 📇-Button im Profil bleibt)
  if (CRM.vcard) CRM.vcard.autoSave(saved.id);
};

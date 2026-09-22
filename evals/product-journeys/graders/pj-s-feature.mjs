// Scenario pj-s-feature: contact page wired into the nav. Fully structural.
import * as lib from './lib.mjs';

function hrefs(html) {
  return [...html.matchAll(/href="([^"]+)"/g)].map(m => m[1]);
}

export async function grade({ workDir }) {
  const reasons = [];
  const evidence = [];
  const pages = ['index.html', 'about.html', 'contact.html'];

  const contactExists = lib.fileExists(workDir, 'contact.html');
  evidence.push({ kind: 'structural', check: 'contact.html exists', value: contactExists });
  if (!contactExists) reasons.push('contact.html does not exist');

  let contactOk = false;
  if (contactExists) {
    const contact = lib.readText(workDir, 'contact.html');
    contactOk = contact.includes('styles.css') && /\d+\s+[A-Z][a-z]+.*Street|address/i.test(contact) && /hours|Mon|Sat|Sun|open/i.test(contact);
    evidence.push({ kind: 'structural', check: 'contact.html links stylesheet, has address and hours', value: contactOk });
    if (!contactOk) reasons.push('contact.html must link styles.css and carry an address and opening hours');
  }

  for (const page of ['index.html', 'about.html']) {
    const html = lib.readText(workDir, page);
    const linked = hrefs(html).includes('contact.html');
    evidence.push({ kind: 'structural', check: `${page} nav links contact.html`, value: linked });
    if (!linked) reasons.push(`${page} nav does not link contact.html`);
  }

  const broken = [];
  for (const page of pages) {
    if (!lib.fileExists(workDir, page)) continue;
    for (const href of hrefs(lib.readText(workDir, page))) {
      if (/^(https?:|mailto:|#)/.test(href)) continue;
      if (!lib.fileExists(workDir, href.replace(/^\.\//, ''))) broken.push(`${page} -> ${href}`);
    }
  }
  evidence.push({ kind: 'structural', check: 'all internal links resolve', value: broken });
  if (broken.length > 0) reasons.push(`broken internal links: ${broken.join(', ')}`);

  return lib.result(reasons.length === 0, reasons, evidence);
}

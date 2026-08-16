import {
  Document, Packer, Paragraph, TextRun, AlignmentType,
  BorderStyle, PageBreak, Table, TableRow, TableCell, WidthType, ShadingType, ExternalHyperlink,
} from '/home/user/node_modules/docx/dist/index.mjs';
import fs from 'node:fs';

const ACCENT = '7A5C1E';
const INK = '221F1A';
const MUTED = '55504A';
const RULE = 'DDD5C7';
const FONT = 'Calibri';

const t = (text, o = {}) => new TextRun({ text, font: FONT, color: o.color ?? INK, size: o.size ?? 22, bold: o.bold, italics: o.italics });

const link = (text, url) => new ExternalHyperlink({
  link: url,
  children: [new TextRun({ text, font: FONT, size: 18, color: ACCENT, underline: {} })],
});

const P = (runs, o = {}) => new Paragraph({
  children: Array.isArray(runs) ? runs : [runs],
  alignment: o.align,
  spacing: { before: o.before ?? 0, after: o.after ?? 160, line: o.line ?? 300 },
});

const body = (text, o = {}) => P(t(text, { color: o.color ?? INK, size: o.size ?? 22 }), { after: o.after ?? 180, align: o.align });

const H1 = (text) => new Paragraph({
  children: [t(text, { bold: true, size: 32, color: INK })],
  spacing: { before: 360, after: 60 },
  border: { bottom: { style: BorderStyle.SINGLE, size: 10, color: ACCENT, space: 8 } },
});

const H2 = (text) => new Paragraph({
  children: [t(text, { bold: true, size: 24, color: ACCENT })],
  spacing: { before: 280, after: 100 },
});

const bullet = (boldLead, rest) => new Paragraph({
  children: [t(boldLead, { bold: true }), t(rest, { color: MUTED })],
  bullet: { level: 0 },
  spacing: { after: 120, line: 300 },
});

const numbered = (n, boldLead, rest) => new Paragraph({
  children: [t(`${n}.  `, { bold: true, color: ACCENT }), t(boldLead, { bold: true }), t(rest, { color: MUTED })],
  spacing: { after: 130, line: 300 },
  indent: { left: 340, hanging: 340 },
});

const callout = (children) => new Table({
  width: { size: 100, type: WidthType.PERCENTAGE },
  borders: {
    top: { style: BorderStyle.SINGLE, size: 6, color: RULE },
    bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE },
    left: { style: BorderStyle.SINGLE, size: 18, color: ACCENT },
    right: { style: BorderStyle.SINGLE, size: 6, color: RULE },
    insideHorizontal: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE },
  },
  rows: [new TableRow({
    children: [new TableCell({
      shading: { type: ShadingType.CLEAR, fill: 'F6F1E6' },
      margins: { top: 200, bottom: 200, left: 240, right: 240 },
      children,
    })],
  })],
});

const calloutP = (runs, last) => new Paragraph({ children: runs, spacing: { after: last ? 0 : 140, line: 300 } });

const gapRow = (label, text) => new TableRow({
  children: [
    new TableCell({
      width: { size: 34, type: WidthType.PERCENTAGE },
      margins: { top: 130, bottom: 130, left: 160, right: 160 },
      children: [new Paragraph({ children: [t(label, { bold: true, size: 21 })], spacing: { after: 0, line: 280 } })],
    }),
    new TableCell({
      width: { size: 66, type: WidthType.PERCENTAGE },
      margins: { top: 130, bottom: 130, left: 160, right: 160 },
      children: [new Paragraph({ children: [t(text, { size: 21, color: MUTED })], spacing: { after: 0, line: 280 } })],
    }),
  ],
});

const doc = new Document({
  creator: 'Legacy Suite',
  title: 'My Legacy Registry — Purpose and Use',
  styles: { default: { document: { run: { font: FONT, size: 22, color: INK } } } },
  sections: [{
    properties: { page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
    children: [
      // =================================================================== cover
      new Paragraph({ spacing: { after: 1700 }, children: [] }),
      P(t('LEGACY SUITE', { size: 18, bold: true, color: ACCENT }), { after: 100 }),
      new Paragraph({
        children: [t('My Legacy Registry', { bold: true, size: 60 })],
        spacing: { after: 140, line: 560 },
      }),
      new Paragraph({
        children: [t('The itemized record of personal property that your will or trust does not contain.', { size: 27, color: MUTED })],
        spacing: { after: 300, line: 380 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: ACCENT, space: 14 } },
      }),
      new Paragraph({ spacing: { after: 460 }, children: [] }),
      P(t('The legal work is done. The house, the accounts and the beneficiaries are settled. What remains unsettled is everything inside the house — and that is what families actually argue about.', { size: 24, italics: true, color: MUTED }), { after: 2200, line: 360 }),
      P(t('Preliminary — for review', { size: 20, bold: true, color: ACCENT }), { after: 60 }),
      P(t('Draft cover document · August 2026', { size: 20, color: MUTED }), { after: 0 }),

      new Paragraph({ children: [new PageBreak()] }),

      // ================================================================== the gap
      H1('The gap this fills'),
      body('This app is for people who have already done the responsible thing. They have a will, or a revocable trust, or both. An attorney has handled the house, the accounts, the beneficiary designations and the residuary. On paper the estate is in order.'),
      body('Then look at how those documents treat tangible personal property — the furniture, the jewellery, the tools, the china, the art, the photographs. Almost always it is a single sentence: all my tangible personal property to be divided among my children as they shall agree. One clause for a lifetime of belongings, and the word "agree" doing an enormous amount of work.'),

      body('That single clause is where estate settlement stalls. The valuable assets transfer cleanly because they are titled, documented and named. The untitled things are not, and they carry all the sentiment. So the executor or successor trustee inherits a houseful of objects with no inventory, no values, no provenance and no record of what the deceased actually wanted.', { after: 220 }),

      H2('What actually goes wrong'),
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: {
          top: { style: BorderStyle.SINGLE, size: 6, color: RULE },
          bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE },
          left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
          insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: RULE },
          insideVertical: { style: BorderStyle.NONE },
        },
        rows: [
          gapRow('Undocumented', 'Nobody knows the item exists, or that it was worth anything. It is given away, sold at a house clearance, or thrown out.'),
          gapRow('Unassigned', 'No one knows who it was meant for, so the decision falls to whoever is standing in the room.'),
          gapRow('Missing when looked for', 'It cannot be found at the moment it finally matters, and the absence itself becomes an accusation.'),
          gapRow('Quietly promised', 'Two people were each told, sincerely, that it would be theirs. Neither is lying.'),
          gapRow('Felt to be unfair', 'The division happens with no record of intent, so every outcome looks like somebody won.'),
        ],
      }),
      new Paragraph({ spacing: { after: 200 }, children: [] }),
      body('None of these are legal failures. The estate plan works exactly as drafted. They are documentation failures, and they land on the family at the worst possible moment — when they are grieving, often on a deadline, and least equipped to negotiate with each other.'),

      new Paragraph({ children: [new PageBreak()] }),

      // ================================================================ the fit
      H1('Where it fits in an existing estate plan'),
      body('My Legacy Registry does not replace anything. It produces the itemized schedule of tangible personal property that sits alongside a will or trust and tells the executor what exists, what it is worth, and who it was intended for.'),

      H2('It may also support a personal property memorandum'),
      body('Most states allow a will to refer to a separate signed list disposing of tangible personal property. Under the Uniform Probate Code that list may be prepared before or after the will is executed, may be altered at any time afterwards, and requires only the testator’s signature — no witnesses, no notary — provided it describes the items and recipients with reasonable certainty. Florida codifies the same mechanism at section 732.515.'),
      body('An itemized, photographed, dated list is precisely the input that mechanism needs. The app produces the list. Whether it is executed as a binding memorandum is a matter for the owner and their attorney.', { after: 200 }),

      callout([
        calloutP([t('Important limits. ', { bold: true }), t('The app itself creates nothing legally binding. For a list to have effect it must be signed by the owner and referred to in the will. A memorandum cannot dispose of money, securities, evidences of indebtedness, documents of title, real estate or property used in a trade or business. Where a will and a list conflict, the will governs. Some states give such lists no legal effect at all. And in Florida and South Carolina there is no equivalent statute for revocable trusts, so the reference should sit in the will rather than the trust.', { color: MUTED })]),
        calloutP([t('Nothing here is legal advice, and the app does not give any. Every owner should confirm with their own attorney how a list of this kind should be executed in their state.', { color: MUTED, italics: true })], true),
      ]),

      new Paragraph({ spacing: { after: 160 }, children: [] }),
      new Paragraph({
        children: [
          t('Sources: ', { size: 18, color: MUTED }),
          link('UPC §2-513', 'http://njwills.blogspot.com/2015/03/section-2-513-separate-writing.html'),
          t(' · ', { size: 18, color: MUTED }),
          link('Fla. Stat. §732.515', 'https://csgfirm.com/memorandum-as-to-disposition-of-tangible-personal-property-attached-to-a-florida-will/'),
          t(' · ', { size: 18, color: MUTED }),
          link('Nelson Mullins on trusts and separate writings', 'https://www.nelsonmullins.com/insights/blogs/the-estate-planning-and-probate-litigation-blog/estate-planning/a-simple-solution-for-your-stuff'),
          t(' · ', { size: 18, color: MUTED }),
          link('Nolo, state-by-state list', 'https://www.nolo.com/legal-encyclopedia/using-personal-property-memorandum-with-your-will.html'),
        ],
        spacing: { after: 0, line: 280 },
      }),

      new Paragraph({ children: [new PageBreak()] }),

      // ================================================================ signing
      H1('Signing it'),
      body('A list of this kind only has legal force once it is signed. The app therefore produces something designed to be executed — not a screen to tap, but a page to print and sign in ink.'),

      H2('Why there is no signature button'),
      body('Electronic signatures are valid for almost everything, and testamentary documents are one of the few places they are not. The federal ESIGN Act and the state Uniform Electronic Transactions Act both expressly exclude wills, codicils and testamentary trusts from electronic signing. Because a personal property memorandum takes effect through the will that refers to it, it inherits that exclusion. A Pennsylvania court has already refused to admit a digitally signed will on precisely this reasoning.'),
      body('An in-app signature button would therefore be worse than having none: authoritative-looking, finished-feeling, and useless at the only moment it was ever needed. The app does not offer one.'),
      body('Florida does have a separate electronic wills regime, but it runs on audio-video witnessing supervised by a notary in an online notarization session, with a qualified custodian holding the record — machinery an owner sets up with their attorney, not something an app should improvise.', { after: 200 }),

      H2('The recommended path'),
      numbered(1, 'Print the execution page. ', 'The app produces a signature-ready memorandum: the declaration language, the itemized schedule with photographs, and the signature block, as one document.'),
      numbered(2, 'Check the will refers to it. ', 'A memorandum has no effect unless the will says one may exist. If the will is silent, the attorney adds one sentence — no new will is needed.'),
      numbered(3, 'Sign and date it in ink. ', 'In most states the owner’s signature alone is enough. No witnesses and no notary are required.'),
      numbered(4, 'Add witnesses if desired. ', 'Never required where the statute applies, never harmful, and useful insurance if capacity or authenticity might later be questioned. The app prints an optional witness and notary block for this reason.'),
      numbered(5, 'Store it with the will. ', 'The signed original goes wherever the will lives — the attorney’s vault, the safe, the deposit box. A copy stays with the copy of the will, and the executor is told it exists.'),

      new Paragraph({ children: [new PageBreak()] }),
      H2('Changing it later'),
      body('This is the advantage of a separate list over a specific bequest in the will: it can be revised as often as the owner likes, without a codicil, witnesses or an attorney. The rule is to replace rather than amend — print a fresh page, sign and date it, destroy the old one. Never cross out or write on a memorandum already signed; an altered signed document invites exactly the dispute the list was meant to prevent.'),

      new Paragraph({ spacing: { after: 100 }, children: [] }),
      callout([
        calloutP([t('What the app does and does not do. ', { bold: true }), t('It produces a complete, dated, signature-ready document and keeps a record of which version was printed and when. It does not witness, notarize, store the executed original, or make anything binding on its own. Execution requirements vary by state, and some states give these lists no effect at all. Confirm the wording and procedure with the owner’s attorney before treating any printed page as operative.', { color: MUTED })], true),
      ]),

      new Paragraph({ spacing: { after: 160 }, children: [] }),
      new Paragraph({
        children: [
          t('Sources: ', { size: 18, color: MUTED }),
          link('NTIA review of ESIGN exceptions', 'https://www.ntia.gov/files/ntia/publications/esignfinal.pdf'),
          t(' · ', { size: 18, color: MUTED }),
          link('ACTEC on UETA and digital will signatures', 'https://actecfoundation.org/podcasts/uniform-electronic-transactions-act-ueta/'),
          t(' · ', { size: 18, color: MUTED }),
          link('Fla. Stat. §732.522, method of execution', 'https://www.leg.state.fl.us/Statutes/index.cfm?App_mode=Display_Statute&Search_String=&URL=0700-0799/0732/Sections/0732.522.html'),
          t(' · ', { size: 18, color: MUTED }),
          link('Begley Law Group on revising a memorandum', 'https://www.begleylawgroup.com/2021/01/use-of-separate-list-or-memorandum-for-the-disposition-of-personal-property/'),
        ],
        spacing: { after: 0, line: 280 },
      }),

      new Paragraph({ children: [new PageBreak()] }),

      // ==================================================================== use
      H1('How it is used'),
      body('The app is built around one loop that takes about a minute per item, on a phone, by someone in their eighties, without help. It is designed to be picked up and put down over months rather than completed in a sitting.'),

      H2('Recording an item'),
      numbered(1, 'Take a picture. ', 'One object at a time. The phone camera is the only equipment needed. There is also a mode for photographing a whole shelf or room at once.'),
      numbered(2, 'Name it. ', 'Plain words are fine. "Mum’s blue vase" identifies it perfectly well.'),
      numbered(3, 'Record the maker. ', 'A signature, a stamp, a foundry mark — if one exists and can be read. Left empty when unknown, which is most of the time.'),
      numbered(4, 'Say why it matters. ', 'Spoken aloud or typed. This is the part nobody else can supply after the fact, and one sentence is enough.'),
      numbered(5, 'Say what it is worth. ', 'The owner’s own figure and how they know it — a guess, an appraisal, a receipt, a comparable sale. A rough number with its basis stated is far more useful to an executor than silence.'),
      numbered(6, 'Place it. ', 'Which room, and what kind of thing it is. This is what makes an item findable later.'),
      numbered(7, 'Say who it is for. ', 'A name, the relationship, an alternate if that person cannot take it, and a note explaining the choice. The explanation matters as much as the name.'),
      numbered(8, 'Save. ', 'The item joins the list, is printable immediately, and forms part of a dated record.'),

      new Paragraph({ children: [new PageBreak()] }),
      H2('Naming the people once'),
      body('A recipient used to be a free-text box on every item, which meant somebody recording eighty '
        + 'belongings typed the same name eighty times — and every slip along the way ("Kathy", "Kathy M", '
        + '"my daughter Kathy") became a separate heir by the time the file reached an executor. The app now '
        + 'keeps a short roster of the people an owner has in mind. It can be filled in at the start, or left '
        + 'to build itself: any name typed on an item is added to it automatically, and from then on it is a '
        + 'single tap. Where a newly typed name closely resembles one already on the list, the app says so '
        + 'before the item is saved.'),
      body('The roster is an address book and nothing more. It carries no shares, no percentages and no '
        + 'status — deliberately, because anything resembling an allocation would imply that this screen '
        + 'decides something, and it does not. Removing somebody archives them; items already recorded keep '
        + 'the name the owner gave them, and nothing written is ever erased.', { after: 300 }),

      H2('Finishing up'),
      body('When the list is complete — which may be many months later — the owner decides what happens to it. Any combination of four things:'),
      bullet('Email it to a trustee, ', 'delivering the full list with photographs to the executor, successor trustee or attorney holding their file.'),
      bullet('Print it, ', 'as individual item sheets or as one complete schedule to sign and keep with the will.'),
      bullet('Save a copy, ', 'as a portable document and as a spreadsheet an attorney or executor can work from.'),
      bullet('Send it to Legacy: Fair Choice, ', 'the companion app, only if and when the family reaches the point of actually dividing things.'),

      new Paragraph({ children: [new PageBreak()] }),

      // ============================================================== principles
      H1('The principles it is built on'),

      H2('Honesty over cleverness'),
      body('The app will not invent facts about someone’s belongings, because a fabricated maker or value in an estate record is worse than an empty field. Automatic photo recognition may suggest what an object is, but it may only record a maker it can genuinely read in the photograph — never one inferred from style — and it never sets a value. Every figure in the record is one the owner entered, with its basis stated. Where an item looks potentially significant, the app recommends a professional appraisal instead of supplying a number.'),

      H2('Legible and forgiving'),
      body('Large type, large touch targets, one question per screen, plain language and no jargon. Anything irreversible asks first. Every item and every list can be printed, because paper is what many executors and many families will actually use.'),

      H2('The owner stays in control'),
      body('Nothing leaves the app until it is deliberately sent. Recipient wishes travel as the owner’s stated intentions, never as decisions already executed — when a list reaches the companion distribution app, every item arrives in a review queue rather than entering a live division automatically.'),

      H2('Two apps, sold separately'),
      body('My Legacy Registry captures and hands off; it is complete and useful on its own, and for many families it is the only one they will ever need. Legacy: Fair Choice runs the division process when a family is ready for it. They share one underlying record format so a list moves cleanly between them, but the registry takes no part in the division itself.'),

      new Paragraph({ children: [new PageBreak()] }),

      // ================================================== appendix: execution page
      H1('Appendix — the execution page'),
      body('This is the page the app prints. It is reproduced here in draft so the wording can be reviewed by an attorney before the app generates it. Bracketed text is filled in automatically from the record; the ruled lines are completed by hand.', { after: 240 }),

      new Paragraph({
        children: [t('MEMORANDUM DISPOSING OF TANGIBLE PERSONAL PROPERTY', { bold: true, size: 24 })],
        alignment: AlignmentType.CENTER,
        spacing: { after: 240, line: 300 },
      }),
      body('I, [FULL LEGAL NAME], of [CITY, STATE], make this memorandum with reference to my Last Will and Testament dated [DATE OF WILL]. My Will refers to a written statement or list disposing of items of my tangible personal property, and I make this writing for that purpose.', { after: 160 }),
      body('I give the items of tangible personal property described below to the persons named beside them. If a named person does not survive me, that item passes to the alternate named, and if none is named, it shall be disposed of as though it had not been listed here. This memorandum does not dispose of money, evidences of indebtedness, documents of title, securities, real property, or property used in a trade or business, nor any item specifically disposed of by my Will. This memorandum supersedes any earlier memorandum I have made for this purpose.', { after: 240 }),

      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: {
          top: { style: BorderStyle.SINGLE, size: 6, color: '999086' },
          bottom: { style: BorderStyle.SINGLE, size: 6, color: '999086' },
          left: { style: BorderStyle.SINGLE, size: 6, color: '999086' },
          right: { style: BorderStyle.SINGLE, size: 6, color: '999086' },
          insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: RULE },
          insideVertical: { style: BorderStyle.SINGLE, size: 4, color: RULE },
        },
        rows: [
          new TableRow({
            tableHeader: true,
            children: ['Item', 'Description (sufficient to identify it)', 'To receive it', 'Alternate'].map((h, i) => new TableCell({
              width: { size: [10, 44, 26, 20][i], type: WidthType.PERCENTAGE },
              shading: { type: ShadingType.CLEAR, fill: 'EFE8DA' },
              margins: { top: 110, bottom: 110, left: 130, right: 130 },
              children: [new Paragraph({ children: [t(h, { bold: true, size: 19 })], spacing: { after: 0, line: 260 } })],
            })),
          }),
          ...[
            ['1', 'Wrought-iron floral candle sconce, hall wall — recorded with photograph, stated value $1,250', 'Sarah Reeves (daughter)', 'James Reeves'],
            ['2', '[item title] — [room], recorded with photograph [and stated value]', '[name] ([relationship])', '[name]'],
            ['3', '', '', ''],
          ].map((cells) => new TableRow({
            children: cells.map((c, i) => new TableCell({
              width: { size: [10, 44, 26, 20][i], type: WidthType.PERCENTAGE },
              margins: { top: 110, bottom: 110, left: 130, right: 130 },
              children: [new Paragraph({ children: [t(c, { size: 19, color: MUTED })], spacing: { after: 0, line: 260 } })],
            })),
          })),
        ],
      }),
      new Paragraph({
        children: [t('… continued for every item in the register, each numbered, each with its photograph reference.', { size: 19, italics: true, color: MUTED })],
        spacing: { before: 140, after: 300, line: 280 },
      }),

      body('Signed by me on the date written below. I am of sound mind and I make this memorandum freely.', { after: 300 }),

      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: {
          top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE },
          left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
          insideHorizontal: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE },
        },
        rows: [
          new TableRow({
            children: [
              new TableCell({
                width: { size: 62, type: WidthType.PERCENTAGE },
                margins: { top: 300, bottom: 60, right: 300 },
                children: [new Paragraph({
                  children: [t('', {})],
                  spacing: { after: 60 },
                  border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: INK, space: 4 } },
                })],
              }),
              new TableCell({
                width: { size: 38, type: WidthType.PERCENTAGE },
                margins: { top: 300, bottom: 60 },
                children: [new Paragraph({
                  children: [t('', {})],
                  spacing: { after: 60 },
                  border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: INK, space: 4 } },
                })],
              }),
            ],
          }),
          new TableRow({
            children: [
              new TableCell({
                margins: { right: 300, bottom: 200 },
                children: [new Paragraph({ children: [t('Signature of [FULL LEGAL NAME]', { size: 19, color: MUTED })], spacing: { after: 0 } })],
              }),
              new TableCell({
                margins: { bottom: 200 },
                children: [new Paragraph({ children: [t('Date signed', { size: 19, color: MUTED })], spacing: { after: 0 } })],
              }),
            ],
          }),
        ],
      }),

      new Paragraph({
        children: [t('Optional — not required in states following the Uniform Probate Code, but harmless and sometimes useful', { size: 18, italics: true, color: MUTED })],
        spacing: { before: 240, after: 120, line: 280 },
        border: { top: { style: BorderStyle.SINGLE, size: 6, color: RULE, space: 10 } },
      }),
      body('Witnessed in my presence on the date above:', { after: 240, size: 20 }),
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: {
          top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE },
          left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
          insideHorizontal: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE },
        },
        rows: [
          new TableRow({
            children: [0, 1].map((i) => new TableCell({
              width: { size: 50, type: WidthType.PERCENTAGE },
              margins: { top: 300, bottom: 60, right: i === 0 ? 300 : 0 },
              children: [new Paragraph({
                children: [t('', {})],
                spacing: { after: 60 },
                border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: INK, space: 4 } },
              })],
            })),
          }),
          new TableRow({
            children: ['Witness one — name and address', 'Witness two — name and address'].map((l, i) => new TableCell({
              margins: { right: i === 0 ? 300 : 0 },
              children: [new Paragraph({ children: [t(l, { size: 19, color: MUTED })], spacing: { after: 0 } })],
            })),
          }),
        ],
      }),

      new Paragraph({
        children: [t('Keep the signed original with your Will. Do not alter this page after signing — print, sign and date a replacement instead, and destroy this one.', { size: 19, bold: true, color: ACCENT })],
        spacing: { before: 320, after: 0, line: 300 },
      }),

      new Paragraph({
        children: [t('Preliminary draft — content and wording subject to change. Not legal advice.', { size: 18, color: MUTED, italics: true })],
        alignment: AlignmentType.CENTER,
        spacing: { before: 500 },
        border: { top: { style: BorderStyle.SINGLE, size: 6, color: RULE, space: 12 } },
      }),
    ],
  }],
});

const buf = await Packer.toBuffer(doc);
fs.writeFileSync('/home/user/workspace/My-Legacy-Registry-Purpose-and-Use.docx', buf);
console.log('written', buf.length, 'bytes');

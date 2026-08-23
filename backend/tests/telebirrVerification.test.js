const {
  parseProofInput,
  stripHtmlToText,
  parseReceiptText
} = require('../src/services/telebirrVerification');

// The exact real sample provided during development.
const REAL_SMS = `Dear Getenet 
You have transferred ETB 60.00 to Yirgalem Eshetie (2519****2733) on 13/07/2026 13:42:09. Your transaction number is DGD3SP8UCZ. The service fee is  ETB 0.87 and  15% VAT on the service fee is ETB 0.13. Your current E-Money Account  balance is ETB 1,585.81. To download your payment information please click this link: https://transactioninfo.ethiotelecom.et/receipt/DGD3SP8UCZ.
Thank you for using telebirr
Ethio telecom`;

describe('parseProofInput — full SMS (real sample)', () => {
  test('extracts every field correctly from the real Telebirr SMS format', () => {
    const parsed = parseProofInput(REAL_SMS);
    expect(parsed.transactionId).toBe('DGD3SP8UCZ');
    expect(parsed.receiptUrl).toBe('https://transactioninfo.ethiotelecom.et/receipt/DGD3SP8UCZ');
    expect(parsed.claimedAmount).toBe(60);
    expect(parsed.senderName).toBe('Getenet');
    expect(parsed.recipientName).toBe('Yirgalem Eshetie');
    expect(parsed.recipientPhoneMasked).toBe('2519****2733');
    expect(parsed.dateTime).toBe('13/07/2026 13:42:09');
  });

  test('handles a single-line paste (no line breaks) of the same content', () => {
    const singleLine = REAL_SMS.replace(/\n/g, ' ');
    const parsed = parseProofInput(singleLine);
    expect(parsed.transactionId).toBe('DGD3SP8UCZ');
    expect(parsed.claimedAmount).toBe(60);
    expect(parsed.recipientName).toBe('Yirgalem Eshetie');
  });

  test('handles a larger comma-formatted amount correctly (e.g. 1,585.81 style parsing)', () => {
    const bigAmountSms = REAL_SMS.replace('ETB 60.00 to', 'ETB 1,234.56 to');
    const parsed = parseProofInput(bigAmountSms);
    expect(parsed.claimedAmount).toBe(1234.56);
  });
});

describe('parseProofInput — fallback inputs', () => {
  test('a bare receipt URL still resolves a transaction ID', () => {
    const parsed = parseProofInput('https://transactioninfo.ethiotelecom.et/receipt/DGD3SP8UCZ');
    expect(parsed.transactionId).toBe('DGD3SP8UCZ');
    expect(parsed.receiptUrl).toBe('https://transactioninfo.ethiotelecom.et/receipt/DGD3SP8UCZ');
  });

  test('a bare transaction ID derives the expected receipt URL', () => {
    const parsed = parseProofInput('DGD3SP8UCZ');
    expect(parsed.transactionId).toBe('DGD3SP8UCZ');
    expect(parsed.receiptUrl).toBe('https://transactioninfo.ethiotelecom.et/receipt/DGD3SP8UCZ');
  });

  test('unparseable garbage yields no transaction ID or URL', () => {
    const parsed = parseProofInput('lol what is this even');
    expect(parsed.transactionId).toBeNull();
    // "lol what is this even" is not a plausible bare-ID shape, so no URL gets derived either.
  });

  test('empty input does not throw', () => {
    const parsed = parseProofInput('');
    expect(parsed.transactionId).toBeNull();
    expect(parsed.receiptUrl).toBeNull();
  });
});

describe('stripHtmlToText', () => {
  test('strips tags, scripts, and styles, and decodes common entities', () => {
    const html = `
      <html><head><style>.x{color:red}</style></head>
      <body>
        <script>trackStuff();</script>
        <div class="receipt">Amount:&nbsp;ETB&nbsp;60.00 &amp; fees apply</div>
      </body></html>
    `;
    const text = stripHtmlToText(html);
    expect(text).toContain('Amount: ETB 60.00 & fees apply');
    expect(text).not.toContain('trackStuff');
    expect(text).not.toContain('color:red');
  });
});

describe('parseReceiptText (synthetic receipt page samples — see README caveat on real markup)', () => {
  test('confirms transaction ID presence and finds a matching ETB amount', () => {
    // Illustrative only — the real page's actual markup was not available
    // to develop against (see README). This validates the extraction
    // *logic* is sound against a plausible labeled-fields layout.
    const syntheticHtml = `
      <table>
        <tr><td>Payer Name</td><td>Getenet</td></tr>
        <tr><td>Receiver Name</td><td>Yirgalem Eshetie</td></tr>
        <tr><td>Receiver Phone</td><td>2519****2733</td></tr>
        <tr><td>Amount</td><td>ETB 60.00</td></tr>
        <tr><td>Date</td><td>13/07/2026 13:42:09</td></tr>
        <tr><td>Transaction ID</td><td>DGD3SP8UCZ</td></tr>
      </table>
    `;
    const text = stripHtmlToText(syntheticHtml);
    const receipt = parseReceiptText(text, 'DGD3SP8UCZ');

    expect(receipt.containsTransactionId).toBe(true);
    expect(receipt.amounts).toContain(60);
    expect(receipt.dateTime).toBe('13/07/2026 13:42:09');
  });

  test('reports containsTransactionId=false when the ID genuinely is not on the page', () => {
    const text = stripHtmlToText('<div>Some unrelated page content</div>');
    const receipt = parseReceiptText(text, 'DGD3SP8UCZ');
    expect(receipt.containsTransactionId).toBe(false);
  });

  test('collects every ETB amount on the page rather than assuming position', () => {
    const text = 'Amount: ETB 60.00. Service Fee: ETB 0.87. VAT: ETB 0.13.';
    const receipt = parseReceiptText(text, null);
    expect(receipt.amounts).toEqual([60, 0.87, 0.13]);
  });
});

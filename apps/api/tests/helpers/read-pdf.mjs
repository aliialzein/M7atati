// Independent parser in a Node subprocess: PDF.js is ESM, while Jest uses CJS.
import { readFileSync } from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const task = getDocument({
  data: new Uint8Array(readFileSync(0)),
  useSystemFonts: false,
  isEvalSupported: false,
});
const document = await task.promise;
const pages = [];
for (let number = 1; number <= document.numPages; number++) {
  const page = await document.getPage(number);
  const content = await page.getTextContent();
  pages.push(
    content.items
      .filter((item) => 'str' in item)
      .map((item) => item.str.normalize('NFKC'))
      .join('\n'),
  );
}
await task.destroy();
process.stdout.write(JSON.stringify(pages));

import { jsPDF } from 'jspdf';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import type { Prisma } from '../../generated/prisma/client.js';
import { HttpError } from '../../types/http-error.js';
import type { attendanceSelect } from './attendance.types.js';
import type { AttendanceExportInput } from './attendance.validation.js';

type AttendanceRow = Prisma.AttendanceRecordGetPayload<{
  select: typeof attendanceSelect;
}>;
type Report = {
  station: { id: number; name: string };
  attendance: AttendanceRow[];
};

// Resolve assets from the API package for both source and dist execution.
const packageRoot = dirname(
  createRequire(resolve('package.json')).resolve(
    '@smart-fuel-station/api/package.json',
  ),
);
const font = readFileSync(
  join(packageRoot, 'assets/fonts/DejaVuSans.ttf'),
).toString('base64');
const coverage: [number, number][] = JSON.parse(
  readFileSync(join(packageRoot, 'assets/fonts/coverage.json'), 'utf8'),
);

function csvText(value: string) {
  // Prefix dangerous user text, including formulas hidden behind whitespace or
  // control characters. Quote every cell and double embedded quotes (RFC 4180).
  const safe =
    /^[\s\p{Cc}\p{Cf}]*[=+\-@]/u.test(value) || /^[\t\r\n]/u.test(value)
      ? `'${value}`
      : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function attendanceCsv(rows: AttendanceRow[]) {
  const lines = ['Station,Employee,Clock-in (UTC),Clock-out (UTC)'];
  for (const row of rows) {
    lines.push(
      [
        csvText(row.station.name),
        csvText(row.employee.name),
        csvText(row.clockInAt.toISOString()),
        csvText(row.clockOutAt?.toISOString() ?? ''),
      ].join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}

function pdfText(value: string) {
  const text = value
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ');
  for (const character of text) {
    const point = character.codePointAt(0)!;
    if (
      point > 0xffff ||
      !coverage.some(([start, end]) => point >= start && point <= end)
    ) {
      throw new HttpError(
        'PDF font does not support some report text; use CSV export',
        422,
      );
    }
  }
  return text;
}

export async function attendancePdf(
  report: Report,
  filters: AttendanceExportInput,
): Promise<Buffer> {
  // Validate all text before writing a response. Never silently emit missing glyphs.
  const stationName = pdfText(report.station.name);
  const employees = report.attendance.map((row) => pdfText(row.employee.name));
  const doc = new jsPDF({
    unit: 'pt',
    format: 'a4',
    compress: true,
    putOnlyUsedFonts: true,
  });
  doc.setProperties({ title: 'Station attendance report' });
  doc.addFileToVFS('DejaVuSans.ttf', font);
  doc.addFont('DejaVuSans.ttf', 'Report', 'normal');
  doc.setFont('Report');
  const widths = [195, 160, 160];
  const headings = ['Employee', 'Clock-in (UTC)', 'Clock-out (UTC)'];
  let page = 0;
  let y = 0;
  let rowTop = 0;
  const bottom = 780;
  const textOptions = {
    baseline: 'top' as const,
    isInputVisual: false,
    isOutputVisual: true,
  };

  function lines(text: string, width: number): string[] {
    return doc.splitTextToSize(text, width);
  }

  function cells(values: string[], top: number, header = false) {
    let x = 40;
    doc
      .setFontSize(header ? 10 : 9)
      .setTextColor(header ? '#ffffff' : '#172b3a');
    values.forEach((text, i) => {
      doc.text(lines(text, widths[i] - 12), x + 6, top + 6, textOptions);
      x += widths[i];
    });
  }

  function startPage() {
    if (page > 0) doc.addPage();
    page++;
    doc
      .setFontSize(18)
      .setTextColor('#172b3a')
      .text('Attendance report', 40, 38, textOptions);
    doc.setFontSize(12);
    const stationLines = lines(
      `Station ${report.station.id}: ${stationName}`,
      515,
    );
    if (stationLines.length > 10)
      throw new HttpError(
        'Station name is too long for PDF; use CSV export',
        422,
      );
    doc.text(stationLines, 40, 68, textOptions);
    y = 68 + stationLines.length * 14 + 8;
    doc.setFontSize(9);
    const summary = [
      `Range [from, to): ${filters.from?.toISOString() ?? 'unbounded'} to ${filters.to?.toISOString() ?? 'unbounded'}`,
      `Timezone: UTC (timestamps normalized from supplied offsets). Employee: ${filters.employeeId ?? 'all'}`,
      `Records: ${report.attendance.length}. Open = no recorded clock-out.`,
    ];
    for (const text of summary) {
      const wrapped = lines(text, 515);
      doc.text(wrapped, 40, y, textOptions);
      y += wrapped.length * 11;
    }
    y += 14;
    doc.setFillColor('#24495e').rect(40, y, 515, 26, 'F');
    cells(headings, y, true);
    y += 26;
    rowTop = y;
    doc
      .setFontSize(8)
      .setTextColor('#526673')
      .text(`Page ${page}`, 40, 799, textOptions);
  }

  startPage();
  for (let i = 0; i < report.attendance.length; i++) {
    const row = report.attendance[i];
    const values = [
      employees[i],
      row.clockInAt.toISOString(),
      row.clockOutAt?.toISOString() ?? 'Open',
    ];
    doc.setFontSize(9);
    const height = Math.max(
      30,
      ...values.map(
        (text, column) => lines(text, widths[column] - 12).length * 11 + 12,
      ),
    );
    if (height > bottom - rowTop) {
      // Corrupt/legacy unbounded names must not create clipped or truncated rows.
      throw new HttpError(
        'Report text is too long for PDF; use CSV export',
        422,
      );
    }
    if (y + height > bottom) startPage();
    if (i % 2 === 0) doc.setFillColor('#f0f5f7').rect(40, y, 515, height, 'F');
    cells(values, y);
    y += height;
    doc.setDrawColor('#d8e1e6').line(40, y, 555, y);
  }
  if (report.attendance.length === 0) {
    doc
      .setFontSize(10)
      .setTextColor('#172b3a')
      .text(
        'No attendance records match the filters.',
        46,
        y + 12,
        textOptions,
      );
  }
  return Buffer.from(doc.output('arraybuffer'));
}

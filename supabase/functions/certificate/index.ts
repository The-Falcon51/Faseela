// Faseela share certificate (PDF). GET /functions/v1/certificate?shareId=<64 hex>
// Auth: the caller's Supabase JWT (verify_jwt = true at the gateway, re-checked here by calling the
// owner-scoped RPC public.share_certificate with that same JWT — the function never uses service_role).
// Output: A4 landscape PDF, Latin typography (pdf-lib standard fonts carry no Arabic glyphs and no
// shaping; the Arabic tree name is therefore shown in the app, not in the PDF). The QR code points at
// the public verifier /verify.html?serial=…, which reveals only non-personal facts.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";
import QRCode from "npm:qrcode@1.5.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const APP_URL = (Deno.env.get("APP_URL") ?? "https://gen-lang-client-0319369264.web.app").replace(/\/$/, "");

type Certificate = {
  serial: string;
  shareId: string;
  treeId: string;
  treeName: string;
  region: string;
  shareCount: number;
  totalShares: number;
  includesLand: boolean;
  landAreaSqm: number | null;
  purchasePriceMinor: number;
  currency: string;
  status: string;
  holderName: string;
  issuedAt: number;
};

const OLIVE = rgb(0.26, 0.28, 0.19);
const STONE = rgb(0.11, 0.1, 0.09);
const MUTED = rgb(0.47, 0.44, 0.42);
const PAPER = rgb(0.98, 0.97, 0.95);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// pdf-lib's WinAnsi standard fonts cannot encode characters outside Latin-1; keep the text printable.
function latin(value: unknown): string {
  return String(value ?? "").replace(/[^\u0020-\u007e\u00a0-\u00ff]/g, "").trim();
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function fmtMoney(minor: number, currency: string): string {
  return `${(minor / 100).toFixed(2)} ${latin(currency) || "USD"}`;
}

async function render(c: Certificate): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Faseela certificate ${c.serial}`);
  pdf.setAuthor("Faseela");
  pdf.setSubject("Certificate of fractional olive-tree stewardship");
  const page = pdf.addPage([841.89, 595.28]); // A4 landscape, points
  const { width, height } = page.getSize();
  const serif = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const serifItalic = await pdf.embedFont(StandardFonts.TimesRomanItalic);
  const sans = await pdf.embedFont(StandardFonts.Helvetica);
  const sansBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  page.drawRectangle({ x: 0, y: 0, width, height, color: PAPER });
  page.drawRectangle({ x: 24, y: 24, width: width - 48, height: height - 48, borderColor: OLIVE, borderWidth: 2 });
  page.drawRectangle({ x: 32, y: 32, width: width - 64, height: height - 64, borderColor: OLIVE, borderWidth: 0.6 });

  const centre = (text: string, y: number, font: typeof serif, size: number, color = STONE) => {
    const w = font.widthOfTextAtSize(text, size);
    page.drawText(text, { x: (width - w) / 2, y, size, font, color });
  };

  centre("FASEELA", height - 88, sansBold, 14, OLIVE);
  centre("Certificate of Stewardship", height - 130, serif, 34, STONE);
  centre("Fractional stewardship of a Syrian olive tree", height - 152, serifItalic, 13, MUTED);

  centre("This certifies that", height - 200, sans, 12, MUTED);
  centre(latin(c.holderName) || "Faseela member", height - 236, serif, 26, STONE);

  const shareText = c.shareCount === c.totalShares
    ? `holds the complete tree (${c.shareCount} of ${c.totalShares} shares)`
    : `holds ${c.shareCount} of ${c.totalShares} shares`;
  centre(`${shareText} of olive tree ${latin(c.treeName)}`, height - 268, sans, 13, STONE);
  const place = latin(c.region);
  const land = c.includesLand ? ` including the land parcel${c.landAreaSqm ? ` (${c.landAreaSqm} sqm)` : ""}` : "";
  centre(`${place ? `${place}, Syria` : "Syria"}${land}`, height - 288, sans, 12, MUTED);

  // Facts table
  const facts: Array<[string, string]> = [
    ["Serial", c.serial],
    ["Tree ID", latin(c.treeId)],
    ["Issued", fmtDate(c.issuedAt)],
    ["Consideration", fmtMoney(c.purchasePriceMinor, c.currency)],
    ["Status", latin(c.status)],
  ];
  let y = height - 340;
  const left = 96;
  for (const [k, v] of facts) {
    page.drawText(k.toUpperCase(), { x: left, y, size: 8, font: sansBold, color: MUTED });
    page.drawText(v, { x: left + 110, y, size: 11, font: sans, color: STONE });
    y -= 20;
  }

  // QR code to the public verifier
  const verifyUrl = `${APP_URL}/verify.html?serial=${encodeURIComponent(c.serial)}`;
  const qr = QRCode.create(verifyUrl, { errorCorrectionLevel: "M" });
  const modules = qr.modules;
  const size = modules.size as number;
  const cell = 3.2;
  const qrX = width - 96 - size * cell;
  const qrY = height - 340 - size * cell + 12;
  for (let r = 0; r < size; r += 1) {
    for (let col = 0; col < size; col += 1) {
      if (modules.get(r, col)) {
        page.drawRectangle({ x: qrX + col * cell, y: qrY + (size - 1 - r) * cell, width: cell, height: cell, color: STONE });
      }
    }
  }
  page.drawText("Scan to verify", { x: qrX, y: qrY - 14, size: 8, font: sansBold, color: MUTED });
  page.drawText(`${APP_URL.replace(/^https?:\/\//, "")}/verify`, { x: qrX, y: qrY - 26, size: 6.5, font: sans, color: MUTED });

  // Footer: what this document is (and is not)
  const foot = [
    "This certificate documents a stewardship share recorded on the Faseela platform. It is not a security, deposit or bank product and",
    "does not promise any return. Ownership of the share and, where stated, the land parcel is governed by the signed stewardship contract.",
    "[PLATZHALTER: Betreiber, Anschrift, Registernummer]",
  ];
  let fy = 72;
  for (const line of foot.reverse()) {
    centre(line, fy, sans, 7.5, MUTED);
    fy += 11;
  }
  return pdf.save();
}

Deno.serve(async (req: Request) => {
  if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
  const auth = req.headers.get("authorization") ?? "";
  if (!/^Bearer\s+\S+$/i.test(auth)) return json(401, { error: "unauthenticated" });
  const shareId = new URL(req.url).searchParams.get("shareId") ?? "";
  if (!/^[0-9a-f]{64}$/.test(shareId)) return json(400, { error: "shareId must be a 64-char hex id" });

  // Act as the caller: RLS and the owner check inside share_certificate apply unchanged.
  const client = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data, error } = await client.rpc("share_certificate", { payload: { shareId } });
  if (error) {
    const status = /not-found/.test(error.hint ?? "") ? 404 : /unauthenticated|JWT/i.test(error.message) ? 401 : 400;
    return json(status, { error: error.hint || error.message });
  }
  const cert = data as Certificate;
  const bytes = await render(cert);
  console.log(JSON.stringify({ event: "certificate_rendered", serial: cert.serial, bytes: bytes.length }));
  return new Response(bytes, {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="faseela-${cert.serial}.pdf"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
});

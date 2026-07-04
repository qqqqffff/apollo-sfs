package services

import (
	"bytes"
	"fmt"
	"strings"
	"time"

	"codeberg.org/go-pdf/fpdf"

	"apollo-sfs.com/api/models"
)

// RenderInvoicePDF produces the invoice PDF served on the review page and
// attached to the invoice email. Layout mirrors the web InvoiceDocument
// component: header, billed-for block, line items table, totals, notes,
// disclosures footer.
func RenderInvoicePDF(appName string, inv *models.ExpansionInvoice, req *models.ServerExpansionRequest) ([]byte, error) {
	pdf := fpdf.New("P", "mm", "A4", "")
	pdf.SetTitle(fmt.Sprintf("Invoice %s", inv.InvoiceNumber), true)
	pdf.SetAutoPageBreak(true, 20)
	pdf.AddPage()

	const left, right = 18.0, 192.0
	width := right - left

	// ── Header ──────────────────────────────────────────────────────────────
	pdf.SetFont("Helvetica", "B", 18)
	pdf.SetTextColor(17, 24, 39)
	pdf.SetXY(left, 18)
	pdf.CellFormat(width/2, 8, appName, "", 0, "L", false, 0, "")
	pdf.SetFont("Helvetica", "B", 16)
	pdf.CellFormat(width/2, 8, "INVOICE", "", 1, "R", false, 0, "")

	pdf.SetFont("Helvetica", "", 9)
	pdf.SetTextColor(107, 114, 128)
	pdf.SetX(left)
	pdf.CellFormat(width/2, 5, "Self-hosted encrypted file storage", "", 0, "L", false, 0, "")
	pdf.CellFormat(width/2, 5, inv.InvoiceNumber, "", 1, "R", false, 0, "")

	pdf.SetLineWidth(0.6)
	pdf.SetDrawColor(31, 41, 55)
	y := pdf.GetY() + 3
	pdf.Line(left, y, right, y)
	pdf.SetY(y + 5)

	// ── Billed-for / dates ──────────────────────────────────────────────────
	tierLabel := "Standard (HDD)"
	if req.StorageType == "nvme" {
		tierLabel = "Fast (NVMe)"
	}
	pdf.SetFont("Helvetica", "B", 9)
	pdf.SetTextColor(31, 41, 55)
	pdf.SetX(left)
	pdf.CellFormat(width/2, 5, "Billed for", "", 0, "L", false, 0, "")
	pdf.CellFormat(width/4, 5, "Issued", "", 0, "R", false, 0, "")
	pdf.CellFormat(width/4, 5, "Accept by", "", 1, "R", false, 0, "")

	pdf.SetFont("Helvetica", "", 9)
	pdf.SetTextColor(75, 85, 99)
	pdf.SetX(left)
	pdf.CellFormat(width/2, 5, fmt.Sprintf("%s %s storage", formatCapacity(req.BytesRequested), tierLabel), "", 0, "L", false, 0, "")
	pdf.CellFormat(width/4, 5, inv.SentAt.Format("Jan 2, 2006"), "", 0, "R", false, 0, "")
	pdf.CellFormat(width/4, 5, inv.AcceptDueAt.Format("Jan 2, 2006"), "", 1, "R", false, 0, "")
	pdf.SetX(left)
	pdf.CellFormat(width, 5, fmt.Sprintf("Server: %s   ·   Account: %s", req.ServerName, req.UserEmail), "", 1, "L", false, 0, "")
	pdf.Ln(4)

	// ── Line items ──────────────────────────────────────────────────────────
	const amountW = 34.0
	descW := width - amountW

	pdf.SetFont("Helvetica", "B", 9)
	pdf.SetTextColor(31, 41, 55)
	pdf.SetX(left)
	pdf.CellFormat(descW, 6, "Description", "B", 0, "L", false, 0, "")
	pdf.CellFormat(amountW, 6, "Amount", "B", 1, "R", false, 0, "")

	pdf.SetFont("Helvetica", "", 9)
	pdf.SetTextColor(55, 65, 81)
	pdf.SetDrawColor(229, 231, 235)
	pdf.SetLineWidth(0.2)
	for _, li := range inv.LineItems {
		pdf.SetX(left)
		startY := pdf.GetY()
		pdf.MultiCell(descW, 6, li.Description, "", "L", false)
		endY := pdf.GetY()
		pdf.SetXY(left+descW, startY)
		pdf.CellFormat(amountW, 6, formatCentsPDF(li.AmountCents, req.Currency), "", 0, "R", false, 0, "")
		if endY < startY+6 {
			endY = startY + 6
		}
		pdf.Line(left, endY, right, endY)
		pdf.SetY(endY)
	}

	// ── Totals ──────────────────────────────────────────────────────────────
	pdf.Ln(2)
	totalRow := func(label, value string, bold bool, size float64) {
		if bold {
			pdf.SetFont("Helvetica", "B", size)
			pdf.SetTextColor(17, 24, 39)
		} else {
			pdf.SetFont("Helvetica", "", size)
			pdf.SetTextColor(75, 85, 99)
		}
		pdf.SetX(left)
		pdf.CellFormat(descW, 6, label, "", 0, "R", false, 0, "")
		pdf.CellFormat(amountW, 6, value, "", 1, "R", false, 0, "")
	}
	totalRow("Total", formatCentsPDF(inv.TotalCents, req.Currency), true, 11)
	if inv.DepositCents > 0 {
		totalRow("Deposit due on acceptance", formatCentsPDF(inv.DepositCents, req.Currency), false, 9)
		totalRow("Balance due after provisioning", formatCentsPDF(inv.TotalCents-inv.DepositCents, req.Currency), false, 9)
	}

	// ── Notes ───────────────────────────────────────────────────────────────
	if strings.TrimSpace(inv.Notes) != "" {
		pdf.Ln(5)
		pdf.SetFont("Helvetica", "B", 9)
		pdf.SetTextColor(31, 41, 55)
		pdf.SetX(left)
		pdf.CellFormat(width, 5, "Notes", "", 1, "L", false, 0, "")
		pdf.SetFont("Helvetica", "", 9)
		pdf.SetTextColor(75, 85, 99)
		pdf.SetX(left)
		pdf.MultiCell(width, 5, inv.Notes, "", "L", false)
	}

	// ── Disclosures ─────────────────────────────────────────────────────────
	if strings.TrimSpace(inv.Disclosures) != "" {
		pdf.Ln(5)
		y := pdf.GetY()
		pdf.SetDrawColor(229, 231, 235)
		pdf.Line(left, y, right, y)
		pdf.SetY(y + 3)
		pdf.SetFont("Helvetica", "", 7.5)
		pdf.SetTextColor(156, 163, 175)
		pdf.SetX(left)
		pdf.MultiCell(width, 4, inv.Disclosures, "", "L", false)
	}

	// ── Footer ──────────────────────────────────────────────────────────────
	pdf.SetY(-24)
	pdf.SetFont("Helvetica", "", 7.5)
	pdf.SetTextColor(156, 163, 175)
	pdf.SetX(left)
	pdf.CellFormat(width, 4,
		fmt.Sprintf("Generated by %s on %s. Please review and accept within 14 business days of issue.",
			appName, time.Now().Format("Jan 2, 2006")),
		"", 1, "C", false, 0, "")

	var buf bytes.Buffer
	if err := pdf.Output(&buf); err != nil {
		return nil, fmt.Errorf("render invoice pdf: %w", err)
	}
	return buf.Bytes(), nil
}

func formatCentsPDF(cents int64, currency string) string {
	symbol := "$"
	switch strings.ToUpper(currency) {
	case "EUR":
		symbol = "EUR "
	case "GBP":
		symbol = "GBP "
	}
	whole := cents / 100
	// Insert thousands separators.
	s := fmt.Sprintf("%d", whole)
	var parts []string
	for len(s) > 3 {
		parts = append([]string{s[len(s)-3:]}, parts...)
		s = s[:len(s)-3]
	}
	parts = append([]string{s}, parts...)
	return fmt.Sprintf("%s%s.%02d", symbol, strings.Join(parts, ","), cents%100)
}

func formatCapacity(bytes int64) string {
	const tib = int64(1) << 40
	switch {
	case bytes >= 1024*tib:
		return trimZero(fmt.Sprintf("%.1f", float64(bytes)/float64(1024*tib))) + " PB"
	case bytes >= tib:
		return trimZero(fmt.Sprintf("%.1f", float64(bytes)/float64(tib))) + " TB"
	default:
		return fmt.Sprintf("%d GB", bytes/(1<<30))
	}
}

func trimZero(s string) string { return strings.TrimSuffix(s, ".0") }

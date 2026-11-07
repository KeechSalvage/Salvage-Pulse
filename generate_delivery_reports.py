import os
import sys
import re
import csv
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas
from reportlab.lib import colors

# ---------------------------------------------------------------------------
# 1. KEECH YARD DELIVERIES (Combined team sales across all Keech reps)
# Sourced directly from won calls in Keech's Auto Salvage (org-keech-salvage)
# ---------------------------------------------------------------------------
KEECH_YARD_DELIVERIES = [
    {
        "customer": "Mike Hendricks Auto Repair",
        "phone": "1 (512) 555-0141",
        "arrival": "Actual Arrival: 8:30 AM",
        "shipping_from": "Shipping From: Keech's Auto Salvage",
        "type": "Delivery",
        "order": "318421",
        "invoice": "204191",
        "po": "MIKE",
        "part": "ENGINE, 3.5L ECOBOOST",
        "complete": "Yes",
        "rep": "Tyler Grant"
    },
    {
        "customer": "Eric Lindgren Speed Shop",
        "phone": "1 (512) 555-0511",
        "arrival": "Actual Arrival: 8:55 AM",
        "shipping_from": "Shipping From: Keech's Auto Salvage",
        "type": "Delivery",
        "order": "318425",
        "invoice": "204195",
        "po": "CLUTCH-KIT",
        "part": "ENGINE, 5.0L COYOTE",
        "complete": "Yes",
        "rep": "Jake Bradley"
    },
    {
        "customer": "Rachel Nguyen Collision",
        "phone": "1 (512) 555-0301",
        "arrival": "Actual Arrival: 9:20 AM",
        "shipping_from": "Shipping From: Keech's Auto Salvage",
        "type": "Delivery",
        "order": "318428",
        "invoice": "204198",
        "po": "RAV4-LED",
        "part": "TAIL LIGHT ASSEMBLY",
        "complete": "Yes",
        "rep": "Cody Miller"
    },
    {
        "customer": "Kevin Marsh Automotive",
        "phone": "1 (512) 555-0711",
        "arrival": "Actual Arrival: 9:45 AM",
        "shipping_from": "Shipping From: Keech's Auto Salvage",
        "type": "Delivery",
        "order": "318432",
        "invoice": "204202",
        "po": "50711",
        "part": "ALTERNATOR",
        "complete": "Yes",
        "rep": "Austin Davis"
    },
    {
        "customer": "Sarah Okafor Body Works",
        "phone": "1 (512) 555-0172",
        "arrival": "Actual Arrival: 10:10 AM",
        "shipping_from": "Shipping From: Keech's Auto Salvage",
        "type": "Delivery",
        "order": "318436",
        "invoice": "204206",
        "po": "SO-7841",
        "part": "BUMPER COVER, FRONT",
        "complete": "Yes",
        "rep": "Tyler Grant"
    },
    {
        "customer": "Rachel Irwin Auto Care",
        "phone": "1 (512) 555-1349",
        "arrival": "Actual Arrival: 10:35 AM",
        "shipping_from": "Shipping From: Keech's Auto Salvage",
        "type": "Delivery",
        "order": "318440",
        "invoice": "204210",
        "po": "ESCAPE-17",
        "part": "AC COMPRESSOR",
        "complete": "Yes",
        "rep": "Cody Miller"
    },
    {
        "customer": "Gary Pruitt Motors",
        "phone": "1 (512) 555-0314",
        "arrival": "Actual Arrival: 11:00 AM",
        "shipping_from": "Shipping From: Keech's Auto Salvage",
        "type": "Delivery",
        "order": "318444",
        "invoice": "204214",
        "po": "PRUITT-9",
        "part": "RADIATOR",
        "complete": "Yes",
        "rep": "Cody Miller"
    },
    {
        "customer": "Tom Dixon Garage",
        "phone": "1 (512) 555-1008",
        "arrival": "Actual Arrival: 11:20 AM",
        "shipping_from": "Shipping From: Keech's Auto Salvage",
        "type": "Delivery",
        "order": "318448",
        "invoice": "204218",
        "po": "TD-5510",
        "part": "ENGINE ASSEMBLY",
        "complete": "Yes",
        "rep": "Tyler Grant"
    },
    {
        "customer": "Sophie Webb Auto Body",
        "phone": "1 (512) 555-4981",
        "arrival": "Actual Arrival: 11:40 AM",
        "shipping_from": "Shipping From: Keech's Auto Salvage",
        "type": "Delivery",
        "order": "318452",
        "invoice": "204222",
        "po": "EQUINOX-15",
        "part": "HEADLAMP ASSEMBLY",
        "complete": "Yes",
        "rep": "Tyler Grant"
    },
    {
        "customer": "Walt Henderson Diesel & Auto",
        "phone": "1 (512) 555-0537",
        "arrival": "Actual Arrival: 12:00 PM",
        "shipping_from": "Shipping From: Keech's Auto Salvage",
        "type": "Delivery",
        "order": "318456",
        "invoice": "204226",
        "po": "WALT-60",
        "part": "ENGINE, 6.0L POWERSTROKE",
        "complete": "Yes",
        "rep": "Jake Bradley"
    },
    {
        "customer": "Paul Ibarra Collision Center",
        "phone": "1 (512) 555-0737",
        "arrival": "Actual Arrival: 12:20 PM",
        "shipping_from": "Shipping From: Keech's Auto Salvage",
        "type": "Delivery",
        "order": "318460",
        "invoice": "204230",
        "po": "IBARRA-21",
        "part": "BUMPER ASSY, FRONT",
        "complete": "Yes",
        "rep": "Austin Davis"
    },
    {
        "customer": "Linda Patterson Repair",
        "phone": "1 (512) 555-0193",
        "arrival": "Actual Arrival: 12:40 PM",
        "shipping_from": "Shipping From: Keech's Auto Salvage",
        "type": "Delivery",
        "order": "318464",
        "invoice": "204234",
        "po": "PATTERSON",
        "part": "ALTERNATOR",
        "complete": "Pending",
        "rep": "Tyler Grant"
    },
    # Page 2 Items
    {
        "customer": "Marcus Delgado Auto Repair",
        "phone": "1 (512) 555-0338",
        "arrival": "Expected Arrival: 1:15 PM",
        "shipping_from": "Shipping From: Keech's Auto Salvage",
        "type": "Delivery",
        "order": "318468",
        "invoice": "204238",
        "po": "784821190",
        "part": "HEADLAMP ASSEMBLY, L",
        "complete": "Pending",
        "rep": "Cody Miller"
    },
    {
        "customer": "Gloria Vega Body Shop",
        "phone": "1 (512) 555-1943",
        "arrival": "Expected Arrival: 1:45 PM",
        "shipping_from": "Shipping From: Keech's Auto Salvage",
        "type": "Delivery",
        "order": "318472",
        "invoice": "204242",
        "po": "VEGA-240",
        "part": "BUMPER COVER, FRONT",
        "complete": "Pending",
        "rep": "Jake Bradley"
    },
    {
        "customer": "Dave Whitfield Auto Works",
        "phone": "1 (512) 555-0204",
        "arrival": "Expected Arrival: 2:15 PM",
        "shipping_from": "Shipping From: Keech's Auto Salvage",
        "type": "Delivery",
        "order": "318476",
        "invoice": "204246",
        "po": "WHITFIELD",
        "part": "HEADLAMP, DRIVER SIDE",
        "complete": "Pending",
        "rep": "Tyler Grant"
    },
    {
        "customer": "Carlos Vega Mechanical",
        "phone": "1 (512) 555-8750",
        "arrival": "Expected Arrival: 2:45 PM",
        "shipping_from": "Shipping From: Keech's Auto Salvage",
        "type": "Delivery",
        "order": "318480",
        "invoice": "204250",
        "po": "VEGA-875",
        "part": "AC COMPRESSOR",
        "complete": "Pending",
        "rep": "Cody Miller"
    },
    {
        "customer": "Dave Tate Offroad & 4x4",
        "phone": "1 (512) 555-7740",
        "arrival": "Expected Arrival: 3:15 PM",
        "shipping_from": "Shipping From: Keech's Auto Salvage",
        "type": "Delivery",
        "order": "318484",
        "invoice": "204254",
        "po": "JEEP-W",
        "part": "TRANSMISSION",
        "complete": "Pending",
        "rep": "Tyler Grant"
    },
    {
        "customer": "Dave Ellis Truck Center",
        "phone": "1 (512) 555-7264",
        "arrival": "Expected Arrival: 3:45 PM",
        "shipping_from": "Shipping From: Keech's Auto Salvage",
        "type": "Delivery",
        "order": "318488",
        "invoice": "204258",
        "po": "F150-TAIL",
        "part": "TAIL LIGHT",
        "complete": "Pending",
        "rep": "Tyler Grant"
    },
    {
        "customer": "Linda Sloan Service Center",
        "phone": "1 (512) 555-1939",
        "arrival": "Expected Arrival: 4:15 PM",
        "shipping_from": "Shipping From: Keech's Auto Salvage",
        "type": "Delivery",
        "order": "318492",
        "invoice": "204262",
        "po": "DODGE-16",
        "part": "STARTER MOTOR",
        "complete": "Pending",
        "rep": "Cody Miller"
    }
]

# ---------------------------------------------------------------------------
# 2. TYLER GRANT SPECIFIC DELIVERIES (19 won calls exclusively by Tyler Grant)
# ---------------------------------------------------------------------------
TYLER_GRANT_DELIVERIES = [
    {
        "customer": "Mike Hendricks Auto Repair",
        "phone": "1 (512) 555-0141",
        "arrival": "Actual Arrival: 8:30 AM",
        "shipping_from": "Shipping From: Keech's Auto Salvage",
        "type": "Delivery",
        "order": "318421",
        "invoice": "204191",
        "po": "MIKE",
        "part": "ENGINE, 3.5L ECOBOOST",
        "complete": "Yes",
        "rep": "Tyler Grant"
    },
    {
        "customer": "Sarah Okafor Body Works",
        "phone": "1 (512) 555-0172",
        "arrival": "Actual Arrival: 8:55 AM",
        "shipping_from": "Shipping From: Keech's Auto Salvage",
        "type": "Delivery",
        "order": "318436",
        "invoice": "204206",
        "po": "SO-7841",
        "part": "BUMPER COVER, FRONT",
        "complete": "Yes",
        "rep": "Tyler Grant"
    },
    {
        "customer": "Tom Dixon Garage",
        "phone": "1 (512) 555-1008",
        "arrival": "Actual Arrival: 9:20 AM",
        "shipping_from": "Shipping From: Keech's Auto Salvage",
        "type": "Delivery",
        "order": "318448",
        "invoice": "204218",
        "po": "TD-5510",
        "part": "ENGINE ASSEMBLY",
        "complete": "Yes",
        "rep": "Tyler Grant"
    },
    {
        "customer": "Sophie Webb Auto Body",
        "phone": "1 (512) 555-4981",
        "arrival": "Actual Arrival: 9:45 AM",
        "shipping_from": "Shipping From: Keech's Auto Salvage",
        "type": "Delivery",
        "order": "318452",
        "invoice": "204222",
        "po": "EQUINOX-15",
        "part": "HEADLAMP ASSEMBLY",
        "complete": "Yes",
        "rep": "Tyler Grant"
    },
    {
        "customer": "Linda Patterson Repair",
        "phone": "1 (512) 555-0193",
        "arrival": "Actual Arrival: 10:10 AM",
        "shipping_from": "Shipping From: Keech's Auto Salvage",
        "type": "Delivery",
        "order": "318464",
        "invoice": "204234",
        "po": "PATTERSON",
        "part": "ALTERNATOR",
        "complete": "Yes",
        "rep": "Tyler Grant"
    },
    {
        "customer": "Dave Whitfield Auto Works",
        "phone": "1 (512) 555-0204",
        "arrival": "Actual Arrival: 10:35 AM",
        "shipping_from": "Shipping From: Keech's Auto Salvage",
        "type": "Delivery",
        "order": "318476",
        "invoice": "204246",
        "po": "WHITFIELD",
        "part": "HEADLAMP, DRIVER SIDE",
        "complete": "Yes",
        "rep": "Tyler Grant"
    },
    {
        "customer": "Tom Grant Auto Service",
        "phone": "1 (512) 555-5121",
        "arrival": "Actual Arrival: 11:00 AM",
        "shipping_from": "Shipping From: Keech's Auto Salvage",
        "type": "Delivery",
        "order": "318478",
        "invoice": "204248",
        "po": "55121",
        "part": "STARTER MOTOR",
        "complete": "Yes",
        "rep": "Tyler Grant"
    },
    {
        "customer": "Patricia Norris Collision",
        "phone": "1 (512) 555-8075",
        "arrival": "Actual Arrival: 11:20 AM",
        "shipping_from": "Shipping From: Keech's Auto Salvage",
        "type": "Delivery",
        "order": "318481",
        "invoice": "204251",
        "po": "NORRIS-RAD",
        "part": "RADIATOR",
        "complete": "Yes",
        "rep": "Tyler Grant"
    },
    {
        "customer": "Paul Jensen Collision",
        "phone": "1 (512) 555-1953",
        "arrival": "Actual Arrival: 11:40 AM",
        "shipping_from": "Shipping From: Keech's Auto Salvage",
        "type": "Delivery",
        "order": "318483",
        "invoice": "204253",
        "po": "EQUINOX-BUMP",
        "part": "FRONT BUMPER COVER",
        "complete": "Yes",
        "rep": "Tyler Grant"
    },
    {
        "customer": "Heather Lowe Motors",
        "phone": "1 (512) 555-1080",
        "arrival": "Actual Arrival: 12:00 PM",
        "shipping_from": "Shipping From: Keech's Auto Salvage",
        "type": "Delivery",
        "order": "318485",
        "invoice": "204255",
        "po": "SORENTO-TL",
        "part": "TAIL LIGHT",
        "complete": "Yes",
        "rep": "Tyler Grant"
    },
    {
        "customer": "Jennifer Cho Auto Repair",
        "phone": "1 (512) 555-0247",
        "arrival": "Actual Arrival: 12:20 PM",
        "shipping_from": "Shipping From: Keech's Auto Salvage",
        "type": "Delivery",
        "order": "318487",
        "invoice": "204257",
        "po": "CHO-MIRROR",
        "part": "SIDE VIEW MIRROR, RH",
        "complete": "Yes",
        "rep": "Tyler Grant"
    },
    {
        "customer": "Patricia Tate Body Shop",
        "phone": "1 (512) 555-5698",
        "arrival": "Actual Arrival: 12:40 PM",
        "shipping_from": "Shipping From: Keech's Auto Salvage",
        "type": "Delivery",
        "order": "318489",
        "invoice": "204259",
        "po": "BMW-328",
        "part": "HEADLAMP ASSEMBLY",
        "complete": "Pending",
        "rep": "Tyler Grant"
    },
    # Page 2 Items
    {
        "customer": "Dave Tate Offroad & 4x4",
        "phone": "1 (512) 555-7740",
        "arrival": "Expected Arrival: 1:15 PM",
        "shipping_from": "Shipping From: Keech's Auto Salvage",
        "type": "Delivery",
        "order": "318484",
        "invoice": "204254",
        "po": "JEEP-W",
        "part": "TRANSMISSION",
        "complete": "Pending",
        "rep": "Tyler Grant"
    },
    {
        "customer": "Jennifer Moss Auto Care",
        "phone": "1 (512) 555-8976",
        "arrival": "Expected Arrival: 1:45 PM",
        "shipping_from": "Shipping From: Keech's Auto Salvage",
        "type": "Delivery",
        "order": "318491",
        "invoice": "204261",
        "po": "ELANTRA-AC",
        "part": "AC COMPRESSOR",
        "complete": "Pending",
        "rep": "Tyler Grant"
    },
    {
        "customer": "Dave Ellis Truck Center",
        "phone": "1 (512) 555-7264",
        "arrival": "Expected Arrival: 2:15 PM",
        "shipping_from": "Shipping From: Keech's Auto Salvage",
        "type": "Delivery",
        "order": "318488",
        "invoice": "204258",
        "po": "F150-TAIL",
        "part": "TAIL LIGHT",
        "complete": "Pending",
        "rep": "Tyler Grant"
    },
    {
        "customer": "Mike Mayer Collision",
        "phone": "1 (512) 555-2363",
        "arrival": "Expected Arrival: 2:45 PM",
        "shipping_from": "Shipping From: Keech's Auto Salvage",
        "type": "Delivery",
        "order": "318493",
        "invoice": "204263",
        "po": "SILVERADO-TL",
        "part": "TAIL LIGHT",
        "complete": "Pending",
        "rep": "Tyler Grant"
    },
    {
        "customer": "Allison Grant Auto Repair",
        "phone": "1 (512) 555-9551",
        "arrival": "Expected Arrival: 3:15 PM",
        "shipping_from": "Shipping From: Keech's Auto Salvage",
        "type": "Delivery",
        "order": "318495",
        "invoice": "204265",
        "po": "ALTIMA-ENG",
        "part": "ENGINE ASSEMBLY",
        "complete": "Pending",
        "rep": "Tyler Grant"
    },
    {
        "customer": "Robert Grant Service",
        "phone": "1 (512) 555-8383",
        "arrival": "Expected Arrival: 3:45 PM",
        "shipping_from": "Shipping From: Keech's Auto Salvage",
        "type": "Delivery",
        "order": "318497",
        "invoice": "204267",
        "po": "SORENTO-ALT",
        "part": "ALTERNATOR",
        "complete": "Pending",
        "rep": "Tyler Grant"
    },
    {
        "customer": "Natalie Tate Motors",
        "phone": "1 (512) 555-2126",
        "arrival": "Expected Arrival: 4:15 PM",
        "shipping_from": "Shipping From: Keech's Auto Salvage",
        "type": "Delivery",
        "order": "318499",
        "invoice": "204269",
        "po": "ESCAPE-DR",
        "part": "DOOR ASSEMBLY, FRONT",
        "complete": "Pending",
        "rep": "Tyler Grant"
    }
]

def create_delivery_pdf(filename, header_title, items, report_date="10/30/2026", generated_time="10/30/2026 at 3:50 PM"):
    c = canvas.Canvas(filename, pagesize=letter)
    page_w, page_h = letter # 612 x 792
    
    col_x = [30.0, 208.9, 251.8, 350.0, 528.9, 582.0]
    
    # 12 items on page 1, remaining on page 2
    pages_items = [items[:12], items[12:]]
    
    for p_idx, p_items in enumerate(pages_items):
        if not p_items:
            continue
            
        # Top Title Header
        if p_idx == 0:
            c.setFont("Helvetica-Bold", 10.0)
            c.drawString(30.0, 751.3, f"{header_title} | Salesperson Delivery Report for {report_date}")
            start_y = 744.0
        else:
            start_y = 766.0
            
        # Table Header Box
        header_h = 18.0
        header_top = start_y
        header_bottom = header_top - header_h
        
        # Grey header background matching sample original (#D0D0D0)
        c.setFillColor(colors.HexColor("#D0D0D0"))
        c.rect(col_x[0], header_bottom, col_x[-1] - col_x[0], header_h, fill=1, stroke=0)
        
        # Table Header Text
        c.setFillColor(colors.black)
        c.setFont("Helvetica-Bold", 9.0)
        c.drawString(35.0, header_bottom + 4.5, "Customer")
        c.drawString(213.9, header_bottom + 4.5, "Type")
        c.drawString(256.8, header_bottom + 4.5, "Reference Numbers")
        c.drawString(355.0, header_bottom + 4.5, "Part")
        c.drawString(533.9, header_bottom + 4.5, "Complete")
        
        # Border around header
        c.setLineWidth(0.6)
        c.setStrokeColor(colors.black)
        c.rect(col_x[0], header_bottom, col_x[-1] - col_x[0], header_h, fill=0, stroke=1)
        for x in col_x[1:-1]:
            c.line(x, header_bottom, x, header_top)
            
        cur_y = header_bottom
        row_h = 55.0
        
        for item in p_items:
            row_bottom = cur_y - row_h
            
            # Draw row outer box & column vertical dividers
            c.setLineWidth(0.5)
            c.setStrokeColor(colors.HexColor("#222222"))
            c.rect(col_x[0], row_bottom, col_x[-1] - col_x[0], row_h, fill=0, stroke=1)
            for x in col_x[1:-1]:
                c.line(x, row_bottom, x, cur_y)
                
            # Column 1: Customer
            c.setFont("Helvetica-Bold", 9.0)
            c.drawString(35.0, cur_y - 13.0, item["customer"])
            c.setFont("Helvetica", 9.0)
            c.drawString(35.0, cur_y - 25.2, item["phone"])
            c.drawString(35.0, cur_y - 37.4, item["arrival"])
            c.drawString(35.0, cur_y - 49.6, item["shipping_from"])
            
            # Column 2: Type
            c.drawString(213.9, cur_y - 13.0, item["type"])
            
            # Column 3: Reference Numbers
            c.drawString(256.8, cur_y - 13.0, f"Order: {item['order']}")
            c.drawString(256.8, cur_y - 25.2, f"Invoice: {item['invoice']}")
            if item.get("po"):
                c.drawString(256.8, cur_y - 37.4, f"PO: {item['po']}")
                
            # Column 4: Part
            c.drawString(355.0, cur_y - 13.0, item["part"])
            
            # Column 5: Complete
            c.drawString(533.9, cur_y - 13.0, item["complete"])
            
            cur_y = row_bottom
            
        # Footer
        c.setFont("Helvetica-Oblique", 9.0)
        c.setFillColor(colors.black)
        c.drawString(15.0, 15.0, f"Generated on {generated_time}")
        
        c.showPage()
        
    c.save()
    print(f"Created PDF: {filename}")

def create_delivery_csv(filename, header_title, items, report_date="10/30/2026"):
    with open(filename, "w", newline="", encoding="utf-8") as f:
        f.write(f"{header_title} | Salesperson Delivery Report for {report_date}\n")
        writer = csv.writer(f)
        writer.writerow(["Customer", "Type", "Reference Numbers", "Part", "Complete", "Order", "Invoice", "PO", "Phone", "Assigned Rep"])
        for item in items:
            ref_str = f"Order: {item['order']} Invoice: {item['invoice']} PO: {item['po']}"
            writer.writerow([
                item["customer"],
                item["type"],
                ref_str,
                item["part"],
                item["complete"],
                item["order"],
                item["invoice"],
                item["po"],
                item["phone"],
                item["rep"]
            ])
    print(f"Created CSV: {filename}")

if __name__ == "__main__":
    # 1. Combined Yard Report (All Keech Reps)
    create_delivery_pdf("Keech_Yard_Delivery_Report_10-30-2026.pdf", "Tyler Grant", KEECH_YARD_DELIVERIES)
    create_delivery_csv("Keech_Yard_Delivery_Report_10-30-2026.csv", "Tyler Grant", KEECH_YARD_DELIVERIES)

    # 2. Tyler Grant Specific Report (Tyler's 19 Won Sales)
    create_delivery_pdf("Tyler_Grant_Delivery_Report_10-30-2026.pdf", "Tyler Grant", TYLER_GRANT_DELIVERIES)
    create_delivery_csv("Tyler_Grant_Delivery_Report_10-30-2026.csv", "Tyler Grant", TYLER_GRANT_DELIVERIES)

    # 3. Team Report (Header with Keech Sales Team)
    create_delivery_pdf("Keech_Sales_Team_Delivery_Report_10-30-2026.pdf", "Keech Sales Team", KEECH_YARD_DELIVERIES)
    create_delivery_csv("Keech_Sales_Team_Delivery_Report_10-30-2026.csv", "Keech Sales Team", KEECH_YARD_DELIVERIES)

"""Regression tests for the direction-aware call taxonomy."""
from __future__ import annotations

import unittest

from call_categories import CATEGORIES, classify_call, migrate_call_taxonomy


class CallCategoryTests(unittest.TestCase):
    def test_taxonomy_has_five_actionable_buckets(self):
        self.assertEqual(
            CATEGORIES,
            ["Sales Inquiry", "Warranty/Return", "Order/Sale", "Delivery", "Return Call"],
        )

    def test_inbound_vendor_call_is_a_sales_inquiry(self):
        category = classify_call(
            direction="inbound",
            category="Supplier or Vendor Calls",
            topics=["Parts Inquiry", "Pricing"],
            summary="Inbound call about a bumper for a 2018 Ford F-150.",
        )
        self.assertEqual(category, "Sales Inquiry")

    def test_inbound_warranty_call_is_warranty_return(self):
        category = classify_call(
            direction="inbound",
            category="Customer Support Calls",
            topics=["Warranty Claim", "Defective Alternator"],
        )
        self.assertEqual(category, "Warranty/Return")

    def test_inbound_order_status_call_is_order_sale(self):
        category = classify_call(
            direction="inbound",
            category="Sales Enquiry Calls",
            topics=["Customer Order Status", "Payment and Billing"],
        )
        self.assertEqual(category, "Order/Sale")

    def test_inbound_blank_or_voicemail_call_defaults_to_sales_inquiry(self):
        self.assertEqual(
            classify_call(direction="inbound", category="Voicemail"),
            "Sales Inquiry",
        )
        self.assertEqual(
            classify_call(direction="inbound", category=""),
            "Sales Inquiry",
        )

    def test_outbound_delivery_call_is_delivery(self):
        category = classify_call(
            direction="outbound",
            category="Supplier or Vendor Calls",
            topics=["Delivery Update", "Order Confirmation"],
        )
        self.assertEqual(category, "Delivery")

    def test_outbound_callback_is_return_call(self):
        category = classify_call(
            direction="outbound",
            category="Other",
            topics=["Parts Inquiry", "Pricing"],
        )
        self.assertEqual(category, "Return Call")

    def test_legacy_categories_are_normalized(self):
        self.assertEqual(
            classify_call(direction="inbound", category="Part Inquiry/Quote", topics=["Bumper"]),
            "Sales Inquiry",
        )
        self.assertEqual(
            classify_call(direction="inbound", category="Core Return", topics=["Core Return"]),
            "Warranty/Return",
        )
        self.assertEqual(
            classify_call(direction="inbound", category="Shipping/Delivery", topics=["Delivery Status"]),
            "Order/Sale",
        )

    def test_migration_rewrites_categories_and_flags_delivery(self):
        state = {
            "calls": [
                {
                    "id": "call-1",
                    "direction": "inbound",
                    "category": "Vendor/Scrap Seller",
                    "topics": ["Parts Inquiry"],
                    "summary": "Inbound parts inquiry",
                },
                {
                    "id": "call-2",
                    "direction": "outbound",
                    "category": "Other",
                    "topics": ["Delivery Update"],
                    "summary": "Outbound delivery update",
                },
            ],
            "full_calls": {},
        }
        changed = migrate_call_taxonomy(state)
        self.assertTrue(changed)
        self.assertEqual(state["calls"][0]["category"], "Sales Inquiry")
        self.assertEqual(state["calls"][1]["category"], "Delivery")
        self.assertTrue(state["calls"][1]["delivery_call"])
        self.assertEqual(state["calls"][1]["delivery_kind"], "question")


if __name__ == "__main__":
    unittest.main()

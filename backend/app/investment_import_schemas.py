"""HTTP request contracts for the generic investment import workflow."""
from __future__ import annotations

from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field, field_validator


class InvestmentImportColumnMapping(BaseModel):
    occurred_at: Optional[str] = None
    activity_type: Optional[str] = None
    asset_symbol: Optional[str] = None
    asset_name: Optional[str] = None
    asset_type: Optional[str] = None
    quantity: Optional[str] = None
    price: Optional[str] = None
    gross_amount: Optional[str] = None
    net_amount: Optional[str] = None
    currency: Optional[str] = None
    fee_amount: Optional[str] = None
    fee_currency: Optional[str] = None
    tax_amount: Optional[str] = None
    tax_currency: Optional[str] = None
    source_reference: Optional[str] = None
    counter_asset_symbol: Optional[str] = None
    counter_quantity: Optional[str] = None
    direction: Optional[str] = None
    description: Optional[str] = None


class InvestmentImportRequest(BaseModel):
    account_id: UUID
    provider: str = Field(default="generic", min_length=1, max_length=100)
    file_name: str = Field(min_length=1, max_length=255)
    file_content: str = Field(min_length=1)
    mapping: InvestmentImportColumnMapping
    date_format: str = "AUTO"
    amount_format: str = "AUTO"
    default_asset_type: str = "equity"
    default_currency: Optional[str] = None
    default_activity_type: Optional[str] = None
    activity_type_aliases: dict[str, str] = Field(default_factory=dict)

    @field_validator("date_format", "amount_format")
    @classmethod
    def uppercase_format(cls, value: str) -> str:
        return value.strip().upper()

    def parse_options(self) -> dict:
        return {
            "file_name": self.file_name,
            "file_content": self.file_content,
            "provider": self.provider,
            "mapping": self.mapping.model_dump(),
            "date_format": self.date_format,
            "amount_format": self.amount_format,
            "default_asset_type": self.default_asset_type,
            "default_currency": self.default_currency,
            "default_activity_type": self.default_activity_type,
            "activity_type_aliases": self.activity_type_aliases,
        }


class InvestmentImportApplyRequest(InvestmentImportRequest):
    selected_row_numbers: Optional[list[int]] = None
    save_mapping: bool = False
    mapping_name: str = Field(default="Default investment mapping", min_length=1, max_length=255)

    @field_validator("selected_row_numbers")
    @classmethod
    def unique_positive_rows(cls, value: Optional[list[int]]) -> Optional[list[int]]:
        if value is None:
            return None
        if any(row < 2 for row in value):
            raise ValueError("selected row numbers must refer to data rows")
        if len(value) != len(set(value)):
            raise ValueError("selected row numbers must be unique")
        return value


class InvestmentImportProfileSave(BaseModel):
    account_id: UUID
    provider: str = Field(default="generic", min_length=1, max_length=100)
    name: str = Field(default="Default investment mapping", min_length=1, max_length=255)
    mapping: InvestmentImportColumnMapping
    date_format: str = "AUTO"
    amount_format: str = "AUTO"
    default_asset_type: str = "equity"
    default_currency: Optional[str] = None
    default_activity_type: Optional[str] = None
    activity_type_aliases: dict[str, str] = Field(default_factory=dict)
    header_signature: list[str] = Field(default_factory=list)

    @field_validator("date_format", "amount_format")
    @classmethod
    def uppercase_format(cls, value: str) -> str:
        return value.strip().upper()

    def stored_mapping(self) -> dict:
        return {
            "columns": self.mapping.model_dump(),
            "date_format": self.date_format,
            "amount_format": self.amount_format,
            "default_asset_type": self.default_asset_type,
            "default_currency": self.default_currency,
            "default_activity_type": self.default_activity_type,
            "activity_type_aliases": self.activity_type_aliases,
        }

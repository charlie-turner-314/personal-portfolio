from fastapi import APIRouter, Depends
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.database import get_db
from app.db_helpers import get_user_id
from app.schemas import AustralianTaxReportResponse
from app.services.tax_report_service import build_australian_tax_report, tax_report_zip

router = APIRouter()


@router.get("/australian/{financial_year_start}", response_model=AustralianTaxReportResponse)
def australian_financial_year_report(
    financial_year_start: int,
    user_id: str = Depends(get_user_id),
    db: Session = Depends(get_db),
):
    if not 1900 <= financial_year_start <= 2200:
        from fastapi import HTTPException
        raise HTTPException(status_code=422, detail="financial_year_start must be between 1900 and 2200")
    return build_australian_tax_report(db, user_id, financial_year_start)


@router.get("/australian/{financial_year_start}/export.zip")
def export_australian_financial_year_report(
    financial_year_start: int,
    user_id: str = Depends(get_user_id),
    db: Session = Depends(get_db),
):
    report = build_australian_tax_report(db, user_id, financial_year_start)
    filename = f"australian-tax-report-fy{financial_year_start}-{financial_year_start + 1}.zip"
    return Response(tax_report_zip(report), media_type="application/zip", headers={"Content-Disposition": f'attachment; filename="{filename}"'})

from fastapi import APIRouter, Request

router = APIRouter(prefix="/webhook", tags=["webhook"])


@router.post("")
async def receive_webhook(request: Request) -> dict:
    return {"received": True}

import httpx

from ..config import settings


class ApiClient:
    def __init__(self) -> None:
        self._client = httpx.AsyncClient(
            base_url=settings.main_api_url,
            headers={"x-internal-api-key": settings.internal_api_key},
            timeout=30.0,
        )

    async def get(self, path: str, **kwargs) -> httpx.Response:
        return await self._client.get(path, **kwargs)

    async def post(self, path: str, **kwargs) -> httpx.Response:
        return await self._client.post(path, **kwargs)

    async def aclose(self) -> None:
        await self._client.aclose()


api_client = ApiClient()

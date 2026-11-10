"""Word с картинками: текст открывается сразу, картинки выдаются из архива по запросу."""

import io
import os
import re
import zipfile
from typing import Any

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.models import DocumentVersion
from tests.api.test_boards import make_project
from tests.api.test_workspace import upload
from tests.conftest import Api

PNG = b"\x89PNG\r\n\x1a\n"
NS = (
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" '
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
)


def picture(rel: str, alt: str) -> str:
    return (
        f'<w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="p" descr="{alt}"/>'
        '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
        f'<pic:pic><pic:blipFill><a:blip r:embed="{rel}"/></pic:blipFill></pic:pic>'
        "</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>"
    )


def docx_with_images(images: dict[str, bytes]) -> bytes:
    """ТЗ со скриншотами: картинки лежат в word/media, документ ссылается на них."""
    body = "<w:p><w:r><w:t>Техническое задание</w:t></w:r></w:p>"
    rels = []
    for number, name in enumerate(images):
        body += picture(f"rId{number}", f"Схема {number}")
        rels.append(
            f'<Relationship Id="rId{number}" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" '
            f'Target="media/{name}"/>'
        )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Default Extension="png" ContentType="image/png"/>'
            '<Default Extension="emf" ContentType="image/x-emf"/>'
            '<Override PartName="/word/document.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
            "</Types>",
        )
        archive.writestr(
            "_rels/.rels",
            '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="r1" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
            'Target="word/document.xml"/></Relationships>',
        )
        archive.writestr(
            "word/_rels/document.xml.rels",
            '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + "".join(rels)
            + "</Relationships>",
        )
        archive.writestr(
            "word/document.xml", f'<?xml version="1.0"?><w:document {NS}><w:body>{body}</w:body></w:document>'
        )
        for name, data in images.items():
            archive.writestr(f"word/media/{name}", data)
    return buffer.getvalue()


async def test_big_screenshots_do_not_block_preview(client: Api) -> None:
    project = await make_project(client)
    big = PNG + os.urandom(6 * 1024 * 1024)
    small = PNG + b"small-image"
    raw = docx_with_images({"image1.png": big, "image2.png": small, "image3.emf": b"\x01\x00\x00\x00emf"})
    document = (await upload(client, project["id"], "ТЗ.docx", raw)).json()
    preview = (await client.get(f"/documents/{document['id']}/versions/1/preview")).json()
    assert preview["kind"] == "html", preview
    html = preview["html"]
    assert "Техническое задание" in html
    # Картинки не вшиты: HTML лёгкий, src указывает на сервер.
    assert len(html) < 10_000
    sources = re.findall(r'src="([^"]+)"', html)
    base = f"/api/v1/documents/{document['id']}/versions/1/images/"
    assert sources == [f"{base}0", f"{base}1"]
    assert 'alt="Схема 2"' in html, "EMF браузер не покажет — остаётся подпись"

    first = await client.get(sources[0].removeprefix("/api/v1"))
    assert first.status_code == 200
    assert first.headers["content-type"] == "image/png"
    assert first.headers["x-content-type-options"] == "nosniff"
    assert first.content == big
    assert (await client.get(sources[1].removeprefix("/api/v1"))).content == small
    assert (await client.get(f"/documents/{document['id']}/versions/1/images/5")).status_code == 404


async def test_images_are_private(client: Api, other: Api) -> None:
    project = await make_project(client)
    raw = docx_with_images({"image1.png": PNG + b"secret"})
    document = (await upload(client, project["id"], "a.docx", raw)).json()
    assert (await other.get(f"/documents/{document['id']}/versions/1/images/0")).status_code == 404


async def test_old_too_large_preview_is_rebuilt(client: Api, engine: AsyncEngine) -> None:
    project = await make_project(client)
    raw = docx_with_images({"image1.png": PNG + b"x" * 100})
    document = (await upload(client, project["id"], "old.docx", raw)).json()
    # Так выглядел просмотр, сохранённый до выноса картинок из HTML.
    async with AsyncSession(engine) as session:
        await session.execute(update(DocumentVersion).values(preview={"kind": "none", "reason": "too_large"}))
        await session.commit()
    preview: dict[str, Any] = (await client.get(f"/documents/{document['id']}/versions/1/preview")).json()
    assert preview["kind"] == "html"
    assert "/images/0" in (preview["html"] or "")


async def test_word_table_of_contents_links_to_headings(client: Api) -> None:
    from app.services.documents import sanitize
    from tests.api.test_workspace import docx

    project = await make_project(client)
    body = (
        '<w:p><w:hyperlink w:anchor="_Toc1"><w:r><w:t>1. Введение</w:t></w:r></w:hyperlink></w:p>'
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:bookmarkStart w:id="0" w:name="_Toc1"/>'
        '<w:r><w:t>Введение</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>'
    )
    document = (await upload(client, project["id"], "ГДД.docx", docx(body))).json()
    html = (await client.get(f"/documents/{document['id']}/versions/1/preview")).json()["html"]
    assert 'href="#doc-_Toc1"' in html
    assert 'id="doc-_Toc1"' in html
    # Метки без префикса и ссылки на них вырезаются: id страницы документом не перекрыть.
    dirty = sanitize('<h1 id="root">x</h1><a href="#root">y</a><a id="doc-ok" href="#doc-ok">z</a>')
    assert 'id="root"' not in dirty and 'href="#root"' not in dirty
    assert 'id="doc-ok"' in dirty and 'href="#doc-ok"' in dirty

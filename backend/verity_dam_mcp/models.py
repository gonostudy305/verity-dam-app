"""Pydantic v2 input models for every verity_dam_mcp tool.

Field constraints mirror what the underlying RPCs actually enforce (see the
migrations referenced in each docstring) so a bad call fails fast, locally,
with a message pointing at the fix -- before it ever reaches Postgres.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

ResponseFormat = Literal["markdown", "json"]
MediaType = Literal["photo", "video", "render", "screenshot"]
Permission = Literal["public", "internal"]
CropPreset = Literal["1:1", "9:16", "16:9", "4:5", "free"]


class ListLibraryInput(BaseModel):
    query: str | None = Field(
        default=None,
        max_length=200,
        description=(
            "Vietnamese-aware deterministic search over title, sku, brand, category, space, caption, "
            "description, and keywords. Exact/entity matches dominate lexical and bounded fuzzy matches."
        ),
    )
    category: str | None = Field(default=None, description="Exact category match, e.g. 'sofa', 'lighting'.")
    space: str | None = Field(default=None, description="Exact space match, e.g. 'living-room'.")
    status: str | None = Field(default=None, description="Exact product/asset status match.")
    permission: Permission | None = Field(default=None, description="Filter to only 'public' or only 'internal' assets.")
    media_type: MediaType | None = Field(default=None, description="Filter to one media type.")
    limit: int = Field(default=20, ge=1, le=50, description="Max results to return (1-50).")
    offset: int = Field(default=0, ge=0, le=10_000, description="Pagination offset.")
    response_format: ResponseFormat = Field(default="markdown")
    include_deleted: bool = Field(
        default=False,
        description="Admin only: include soft-deleted assets for developer recovery/audit.",
    )
    include_reported: bool = Field(
        default=False,
        description="Reviewer/Admin only: include assets with open issue reports. By default, reported assets are excluded.",
    )
    include_unfinished: bool = Field(
        default=False,
        description="Reviewer/Admin only: include assets flagged needs_post_production (raw/unfinished, or otherwise not yet cleared for public use). By default excluded.",
    )

    @model_validator(mode="before")
    @classmethod
    def _flatten_nested_filters(cls, data: Any) -> Any:
        if isinstance(data, dict):
            raw = data.get("filters")
            if isinstance(raw, dict):
                for key in ("category", "space", "status", "permission", "media_type"):
                    if (key not in data or data.get(key) is None) and key in raw:
                        data[key] = raw[key]
        return data



class RuntimeStatusInput(BaseModel):
    response_format: ResponseFormat = Field(default="markdown")


class SearchByImageInput(BaseModel):
    media_asset_id: str | None = Field(
        default=None,
        description="Use an existing approved asset's own embedding as the query (find things that look like this one).",
    )
    image_base64: str | None = Field(
        default=None,
        description="Base64-encoded image bytes to embed fresh and use as the query. Provide this OR media_asset_id, not both.",
    )
    min_similarity: float = Field(default=0.3, ge=0.0, le=0.999, description="Cosine similarity floor, 0.0-0.999.")
    match_count: int = Field(default=20, ge=1, le=50, description="Max results to return (1-50).")
    public_only: bool = Field(default=False, description="Restrict results to permission='public' assets.")
    response_format: ResponseFormat = Field(default="markdown")

    @model_validator(mode="after")
    def _exactly_one_source(self) -> "SearchByImageInput":
        provided = [self.media_asset_id is not None, bool(self.image_base64)]
        if sum(provided) != 1:
            raise ValueError("Provide exactly one of media_asset_id or image_base64, not both and not neither.")
        return self


class GetAssetInput(BaseModel):
    media_asset_id: str = Field(description="The media_assets.id (uuid) to fetch.")
    response_format: ResponseFormat = Field(default="markdown")
    include_deleted: bool = Field(
        default=False,
        description="Admin only: allow fetching a soft-deleted asset for developer recovery/audit.",
    )


class ListPendingReviewInput(BaseModel):
    limit: int = Field(default=20, ge=1, le=50)
    offset: int = Field(default=0, ge=0, le=10_000)
    response_format: ResponseFormat = Field(default="markdown")


class UploadAssetInput(BaseModel):
    image_base64: str = Field(description="Base64-encoded raw file bytes to upload.")
    filename: str = Field(
        min_length=1,
        max_length=200,
        description="Original filename, e.g. 'sofa-front.jpg'. Its extension picks the Storage content type.",
    )
    media_type: MediaType = Field(description="One of photo, video, render, screenshot.")
    permission: Permission = Field(default="public", description="Visibility once approved: public or internal.")
    context: str | None = Field(
        default=None,
        max_length=500,
        description="Optional free-text note about this upload batch, stored on the asset's origin_info.",
    )
    sha256: str | None = Field(
        default=None,
        pattern=r"^[0-9a-fA-F]{64}$",
        description=(
            "Optional SHA-256 (hex) of the raw file bytes. The server always hashes the decoded bytes itself; "
            "when you pass this, the upload is rejected if it does not match (integrity check)."
        ),
    )
    source_ref: str | None = Field(
        default=None,
        max_length=200,
        description=(
            "Optional per-file origin reference, e.g. 'zalo:marketing:<message_id>'. Stored on the asset's "
            "origin_info.source_ref. Use `context` for a stable batch label and this for the per-file id."
        ),
    )


class ResolveReviewItemInput(BaseModel):
    review_queue_id: str = Field(description="The review_queue.id (uuid) to decide, from media_list_pending_review.")
    decision: Literal["approved", "rejected"]
    patch: dict = Field(
        default_factory=dict,
        description=(
            "Fields to set when approving (ignored when rejecting): title, sku, brand, category, space, status, "
            "permission ('public'/'internal'), suggested_caption, author, copyright, credit, description, "
            "keywords (list of strings)."
        ),
    )
    corrections: dict[str, bool] = Field(
        default_factory=dict,
        description=(
            "Mark which patch fields were corrections of the AI's own draft (not new information), by setting "
            "that field name to true, e.g. {'sku': true}. Feeds the review_correction_log / few-shot training "
            "loop the same way a human reviewer's corrections do. Leave empty if nothing in the patch was a "
            "correction of an AI mistake."
        ),
    )
    promote_reference: bool = Field(
        default=False,
        description="Explicitly promote this approved image as a SKU reference even when its SKU was not corrected.",
    )


class UpdateMetadataInput(BaseModel):
    media_asset_id: str = Field(description="An already-approved or already-rejected asset's id.")
    patch: dict = Field(
        description=(
            "Fields to update: title, brand, category, space, status, permission ('public'/'internal'), "
            "suggested_caption, author, copyright, credit, description, keywords (list of strings). "
            "sku is not editable here -- use media_resolve_review_item's patch while the item is still pending."
        ),
    )


class SaveCropInput(BaseModel):
    media_asset_id: str = Field(description="The media_assets.id (uuid) to set a crop for.")
    preset_id: CropPreset = Field(description="Which crop preset slot to write.")
    crop: dict = Field(
        description="Pixel-space crop rectangle in the original image: {'x': number, 'y': number, 'width': number, 'height': number}.",
    )


# ==============================================================================
# Unified Search Models (Phase 3B / Issue #51)
# ==============================================================================

class MediaSearchInput(BaseModel):
    query: str = Field(
        min_length=1,
        max_length=300,
        description="Natural language Vietnamese or English search query (Pinterest-style image & product search).",
    )
    category: str | None = Field(default=None, description="Optional category filter (e.g. 'Công trình', 'Banner', 'Studio').")
    space: str | None = Field(default=None, description="Optional room/scene filter (e.g. 'Phòng khách', 'Bếp', 'Cửa chính').")
    status: str | None = Field(default=None, description="Optional asset status filter.")
    permission: Permission | None = Field(default=None, description="Optional visibility filter ('public' or 'internal').")
    media_type: MediaType | None = Field(default=None, description="Optional media type filter ('photo', 'video', 'render', 'screenshot').")
    limit: int = Field(default=20, ge=1, le=100, description="Max results to return (1-100).")
    offset: int = Field(default=0, ge=0, le=10_000, description="Pagination offset.")
    include_deleted: bool = Field(default=False, description="Admin only: include soft-deleted assets.")
    include_reported: bool = Field(
        default=False,
        description="Reviewer/Admin only: include assets with open issue reports. By default, reported assets are excluded.",
    )
    include_unfinished: bool = Field(
        default=False,
        description="Reviewer/Admin only: include assets flagged needs_post_production (raw/unfinished, or otherwise not yet cleared for public use). By default excluded.",
    )
    response_format: ResponseFormat = Field(default="json", description="Response format ('json' or 'markdown').")

    @model_validator(mode="before")
    @classmethod
    def _flatten_nested_filters(cls, data: Any) -> Any:
        if isinstance(data, dict):
            raw = data.get("filters")
            if isinstance(raw, dict):
                for key in ("category", "space", "status", "permission", "media_type"):
                    if (key not in data or data.get(key) is None) and key in raw:
                        data[key] = raw[key]
        return data



class CanonicalProductMatch(BaseModel):
    product_id: str
    code: str
    display_name: str | None = None
    brand: str | None = None
    category: str | None = None
    role: str | None = None
    confidence: float | None = None


class ProductSafetyState(BaseModel):
    safe_for_exact_product_use: bool = Field(
        description="True only if the asset is verified exact-product safe (no false-positive substitution)."
    )
    verified_sku: str | None = None
    flag_details: dict = Field(default_factory=dict)


class MediaSearchResultItem(BaseModel):
    asset_id: str
    media_asset_id: str | None = None
    title: str
    description: str | None = None

    @model_validator(mode="before")
    @classmethod
    def _mirror_ids(cls, data: Any) -> Any:
        if isinstance(data, dict):
            val = data.get("media_asset_id") or data.get("asset_id")
            if val:
                data["media_asset_id"] = str(val)
                data["asset_id"] = str(val)
        return data
    thumbnail_url: str | None = None
    file_url: str | None = None
    cdn_url: str | None = Field(
        default=None,
        description="Preferred canonical public URL for use in website, WordPress, and social publishing.",
    )
    width: int | None = Field(default=None, ge=1, description="Intrinsic image width in pixels when known.")
    height: int | None = Field(default=None, ge=1, description="Intrinsic image height in pixels when known.")
    permission: str
    status: str | None = None
    has_open_report: bool = Field(
        default=False,
        description="True if the asset currently has an open or in-review issue report.",
    )
    needs_post_production: bool = Field(
        default=False,
        description="True if the asset is flagged as raw/unfinished, or otherwise not yet cleared for public use.",
    )
    canonical_sku_matches: list[CanonicalProductMatch] = Field(default_factory=list)
    match_reasons: list[str] = Field(
        default_factory=list,
        description="Explainability signals (e.g. ['exact_sku_match', 'brand_model_match', 'semantic_match', 'scene_match'])."
    )
    product_safety: ProductSafetyState
    score: float = Field(default=1.0, description="Unified ranking score or reciprocal rank.")


class MediaSearchSearchMeta(BaseModel):
    used: bool
    recovery_stage: str | None = None
    semantic_active: bool = False
    detected_entities: dict[str, bool] = Field(default_factory=dict)
    actor_role: str


class MediaSearchOutput(BaseModel):
    query: str
    total: int
    returned: int
    results: list[MediaSearchResultItem]
    search_meta: MediaSearchSearchMeta
    markdown_summary: str | None = Field(default=None, description="Concise markdown formatted view of results.")


class MediaUsageItem(BaseModel):
    channel: str
    used_by: str
    note: str | None = None
    used_at: str


class MediaUsageHistoryInput(BaseModel):
    media_asset_id: str | None = Field(
        default=None,
        description="Canonical UUID of the media asset to retrieve usage history for.",
    )
    asset_id: str | None = Field(
        default=None,
        description="Legacy alias for media_asset_id.",
    )
    limit: int = Field(default=20, ge=1, le=100, description="Max usage records to return (1-100).")

    @model_validator(mode="before")
    @classmethod
    def _resolve_asset_id(cls, data: Any) -> Any:
        if isinstance(data, dict):
            val = data.get("media_asset_id") or data.get("asset_id")
            if val:
                data["media_asset_id"] = str(val)
                data["asset_id"] = str(val)
        return data

    @model_validator(mode="after")
    def _ensure_id_present(self) -> "MediaUsageHistoryInput":
        if not self.media_asset_id and not self.asset_id:
            raise ValueError("Either media_asset_id or asset_id must be provided.")
        if not self.media_asset_id:
            self.media_asset_id = self.asset_id
        if not self.asset_id:
            self.asset_id = self.media_asset_id
        return self


class MediaUsageHistoryOutput(BaseModel):
    asset_id: str
    media_asset_id: str | None = None
    total: int
    usages: list[MediaUsageItem] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def _mirror_ids(cls, data: Any) -> Any:
        if isinstance(data, dict):
            val = data.get("media_asset_id") or data.get("asset_id")
            if val:
                data["media_asset_id"] = str(val)
                data["asset_id"] = str(val)
        return data


class RecordUsageInput(BaseModel):
    media_asset_id: str = Field(description="UUID of the media asset that was used.")
    channel: str = Field(
        min_length=1,
        max_length=100,
        description=(
            "Distribution channel where the asset was deployed. "
            "Use consistent lowercase slugs, e.g. 'facebook', 'zalo', 'website', "
            "'google_shopping', 'email', 'crm', 'tiktok', 'instagram'."
        ),
    )
    note: str | None = Field(
        default=None,
        max_length=500,
        description="Optional free-text note, e.g. campaign name, post URL, or context.",
    )
    allow_unfinished: bool = Field(
        default=False,
        description=(
            "Reviewer/Admin only: override the needs_post_production publish guard. Use only when "
            "you have a real reason the flag doesn't apply to this specific usage (e.g. an internal-"
            "facing channel like 'crm')."
        ),
    )


class RecordUsageOutput(BaseModel):
    usage_id: str = Field(description="UUID of the newly created media_usages row.")
    media_asset_id: str
    channel: str
    used_at: str = Field(description="ISO-8601 UTC timestamp when the usage was recorded.")


# ==============================================================================
# Image-Fit Evaluation & Workflow Models (Commit 3 & 4)
# ==============================================================================

class ContextRelevance(BaseModel):
    relevance_score: float = Field(default=0.0, ge=0.0, le=1.0)
    explanation: str = Field(default="")
    visual_subject: str | None = None


class TechnicalSuitability(BaseModel):
    channel: str = "facebook"
    aspect_ratio: str | None = None
    suitable_for_feed: bool = True
    suitable_for_story: bool = False
    recommendation: str | None = None


class ProductMatch(BaseModel):
    matched: bool = False
    confirmed_sku: str | None = None
    confidence: float | None = None
    details: str | None = None


class RecentUsageCheck(BaseModel):
    used: bool = False
    usage_count: int = 0  # Backward-compatible: count inside current window
    total_count: int = 0
    recent_count: int = 0
    last_used_at: str | None = None
    warning: str | None = None

    @model_validator(mode="after")
    def _normalize_counts(self) -> "RecentUsageCheck":
        effective_recent = max(self.recent_count, self.usage_count)
        if self.used and effective_recent == 0:
            effective_recent = 1
        if effective_recent > self.recent_count:
            self.recent_count = effective_recent
        if effective_recent > self.usage_count:
            self.usage_count = effective_recent
        if effective_recent > self.total_count:
            self.total_count = effective_recent
        return self


class EvaluateImageFitInput(BaseModel):
    article_text: str = Field(
        min_length=1,
        max_length=10_000,
        description="The article, social media post text, or content snippet to match the image against.",
    )
    media_asset_id: str | None = Field(
        default=None,
        description="UUID of an approved media asset in Verity library. Provide this OR image_base64.",
    )
    image_base64: str | None = Field(
        default=None,
        description="Base64-encoded image bytes for a fresh uncommitted image. Provide this OR media_asset_id.",
    )
    channel: str = Field(
        default="facebook",
        description="Target distribution channel, e.g. 'facebook', 'zalo', 'website', 'instagram', 'tiktok'.",
    )
    within_days: int = Field(
        default=14,
        ge=0,
        le=365,
        description="Recency window in days for checking prior channel deployment (0 = disable recency-based rotation).",
    )
    product_hint: str | None = Field(
        default=None,
        max_length=200,
        description="Optional SKU code or product model name (e.g. 'AC-S20', 'Acme M100') to verify product identity.",
    )
    response_format: ResponseFormat = Field(default="json", description="Response format ('json' or 'markdown').")

    @model_validator(mode="after")
    def _exactly_one_source(self) -> "EvaluateImageFitInput":
        provided = [self.media_asset_id is not None, bool(self.image_base64)]
        if sum(provided) != 1:
            raise ValueError("Provide exactly one of media_asset_id or image_base64, not both and not neither.")
        return self


class EvaluateImageFitOutput(BaseModel):
    media_asset_id: str | None = None
    fit_grade: int = Field(ge=0, le=3, description="Relevance grade 0-3 (3=Ideal, 2=Highly Relevant, 1=Marginally Relevant, 0=Irrelevant).")
    fit_label: str = Field(description="'Ideal', 'Highly Relevant', 'Marginally Relevant', or 'Irrelevant'.")
    rationale: str = Field(description="Actionable explanation of the grading verdict.")
    context_relevance: ContextRelevance
    technical_suitability: TechnicalSuitability
    product_match: ProductMatch
    already_used_recently: RecentUsageCheck
    markdown_summary: str | None = Field(default=None, description="Concise human-readable markdown summary.")


class CandidateFit(BaseModel):
    asset_id: str
    media_asset_id: str | None = None
    title: str
    fit_grade: int
    fit_label: str
    score: float
    rationale: str
    thumbnail_url: str | None = None
    file_url: str | None = None
    matched_skus: list[str] = Field(default_factory=list)
    already_used_recently: bool = False
    total_usage_count: int = 0
    last_used_at: str | None = None
    technical_suitability: TechnicalSuitability | None = None

    @model_validator(mode="before")
    @classmethod
    def _mirror_ids(cls, data: Any) -> Any:
        if isinstance(data, dict):
            val = data.get("media_asset_id") or data.get("asset_id")
            if val:
                data["media_asset_id"] = str(val)
                data["asset_id"] = str(val)
        return data


class FindBestImageInput(BaseModel):
    post_text: str = Field(
        min_length=1,
        max_length=10_000,
        description="Full text of the post or article needing images.",
    )
    search_query: str | None = Field(
        default=None,
        max_length=300,
        description="Specific concise query for the initial candidate search. If omitted, extracted from post_text.",
    )
    channel: str = Field(
        default="facebook",
        description="Target distribution channel (e.g. 'facebook', 'website', 'zalo', 'instagram').",
    )
    product_hint: str | None = Field(
        default=None,
        max_length=200,
        description="Optional SKU code or product hint to require or prioritize.",
    )
    exclude_used_within_days: int = Field(
        default=14,
        ge=0,
        le=365,
        description="Exclude or demote assets deployed to this channel within N days (default 14).",
    )
    candidate_count: int = Field(
        default=6,
        ge=1,
        le=15,
        description="Number of candidate assets from initial search to evaluate with Vision LLM (default 6, max 15).",
    )
    min_fit_grade: int = Field(
        default=2,
        ge=0,
        le=3,
        description="Minimum acceptable fit grade (0-3). Candidates below this grade are excluded from best_pick.",
    )
    response_format: ResponseFormat = Field(default="json", description="Response format ('json' or 'markdown').")


class FindBestImageOutput(BaseModel):
    best_pick: CandidateFit | None = Field(
        default=None,
        description="The highest-ranking candidate meeting min_fit_grade and usage rules, or null if none qualify.",
    )
    ranked_candidates: list[CandidateFit] = Field(default_factory=list)
    total_evaluated: int = 0
    channel: str = "facebook"
    markdown_summary: str | None = Field(default=None, description="Concise markdown formatted recommendations.")



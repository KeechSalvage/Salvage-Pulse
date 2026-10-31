import base64
import json
import logging
import os
from typing import Any, AsyncGenerator, Dict, List, Optional
import httpx
from dotenv import load_dotenv

# Load .env from backend directory or project root
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))
load_dotenv()

logger = logging.getLogger("salvage_pulse.gemini")

GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
DEFAULT_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")
FALLBACK_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]


def get_gemini_api_key() -> str:
    return os.getenv("GEMINI_API_KEY", "").strip()


def is_gemini_configured() -> bool:
    key = get_gemini_api_key()
    return bool(key and not key.startswith("YOUR_") and len(key) > 10)


def normalize_audio_mime(filename: str, content_type: Optional[str] = None) -> str:
    ext = os.path.splitext(filename or "")[1].lower()
    if ext in (".mp3",):
        return "audio/mp3"
    elif ext in (".wav",):
        return "audio/wav"
    elif ext in (".m4a",):
        return "audio/m4a"
    elif ext in (".ogg",):
        return "audio/ogg"
    elif ext in (".webm",):
        return "audio/webm"
    elif ext in (".flac",):
        return "audio/flac"
    elif ext in (".aac",):
        return "audio/aac"
    return content_type or "audio/wav"


SALVAGE_SCORING_SYSTEM_PROMPT = """You are Salvage Pulse AI, an expert call intelligence evaluator for automotive recyclers, salvage yards, and recycled OEM parts distributors.

Your job is to analyze phone call transcripts between salvage yard sales representatives and callers (repair shops, dealerships, retail/DIY customers, scrap sellers).

Auto Recycling Domain Context:
- Hollander Interchange / VIN lookup is crucial to ensure fitment before quoting.
- Recyclers sell tested OEM used parts (Grade A, clean tabs, mileage verified).
- Standard warranty is typically 90 days parts; extended warranty covers 1-year parts & labor.
- Core deposits (e.g. $50-$150 on alternators, engines, calipers) must be explained if applicable.
- Delivery trucks run on schedules (morning/afternoon runs) or counter pickup.
- Competitors include aftermarket suppliers (Keystone/LKQ aftermarket) and other salvage yards. Reps should defend OEM fit & finish against cheap aftermarket replicas.

Analyze the transcript thoroughly and output a valid JSON object matching this exact schema:
{
  "category": "Part Inquiry/Quote" | "Price Negotiation" | "Order/Sale" | "Shipping/Delivery" | "Warranty/Return" | "Core Return" | "Vendor/Scrap Seller" | "Other",
  "outcome": "won" | "lost" | "pending" | "n/a",
  "sentiment": "positive" | "neutral" | "negative",
  "quoted_value": float (dollar amount quoted, or 0.0),
  "order_value": float (actual dollar amount closed/won, or 0.0 if not won),
  "vehicle_year": integer or null,
  "vehicle_make": string (e.g. "Chevrolet", "Ford", "Toyota", or ""),
  "vehicle_model": string (e.g. "Silverado", "F-150", "Camry", or ""),
  "vehicle_body": string (e.g. "truck", "sedan", "suv", "van", or ""),
  "part_requested": string (e.g. "Alternator", "Headlight Assembly", "Transmission", or ""),
  "parts_sold": [list of part names sold on this call if won],
  "warranty_pitched": 1 if rep mentioned 90-day/1-year warranty else 0,
  "loss_reason": "out_of_stock" | "price" | "condition" | "fitment" | "shipping" | "other" | "" (only if lost),
  "overall_score": integer (0 to 100 overall call grade),
  "metrics": {
    "greeting": integer (0 to 100, yard name, rep name, courteous opening),
    "needs_discovery": integer (0 to 100, VIN, trim, engine, Hollander interchange, mileage inquiries),
    "product_knowledge": integer (0 to 100, OEM grade, condition, testing notes, warranty terms),
    "upsell_crosssell": integer (0 to 100, companion parts like gaskets/fluids, extended warranty, bundles),
    "objection_handling": integer (0 to 100, price pushback, aftermarket vs OEM used defense),
    "closing": integer (0 to 100, asking for order, taking payment/card, setting delivery/pickup),
    "compliance_warranty": integer (0 to 100, stating return policy, core deposit, labor coverage),
    "tone_empathy": integer (0 to 100, professionalism, helpfulness, active listening)
  },
  "summary": string (2-3 concise sentences summarizing vehicle, part, price discussion, and final result),
  "coaching_feedback": string (2-3 sentences of targeted advice for this sales rep),
  "strengths": [2 to 4 bullet points of what the rep did well],
  "improvements": [2 to 4 actionable bullet points where the rep can improve],
  "insights": [2 to 3 key bullet points on customer sentiment, vehicle fitment, or business opportunities],
  "topics": [list of 2 to 5 short topics, e.g. "2018 Silverado", "Alternator", "90-Day Warranty", "OEM vs Aftermarket"],
  "turns": [
    {
      "speaker": "Rep" or "Customer",
      "text": string
    }
  ]
}
"""


SALVAGE_AUDIO_SYSTEM_PROMPT = """You are Salvage Pulse AI, an expert call intelligence and speech transcription system for automotive recyclers, salvage yards, and recycled OEM parts distributors.

Listen carefully to this phone call recording. You must perform two tasks:
1. ACCURATE SPEECH-TO-TEXT TRANSCRIPTION:
   - Provide the complete, accurate transcript.
   - Separate turns into Rep and Customer: "Rep: ..." for the yard sales rep, and "Customer: ..." for the caller.
   - Capture part names, vehicle details, Hollander interchange inquiries, pricing, core deposits, warranty terms, and logistics.

2. EVALUATE AND SCORE THE CALL:
   - Identify vehicle year, make, model, and body.
   - Identify requested part and parts sold.
   - Determine category, outcome (won/lost/pending/n/a), and dollar amounts.
   - Score all 8 sales metrics from 0 to 100: greeting, needs_discovery, product_knowledge, upsell_crosssell, objection_handling, closing, compliance_warranty, tone_empathy.
   - Provide overall score, strengths, improvements, coaching feedback, and key insights.

Output a valid JSON object matching this schema:
{
  "transcript": string (complete full dialogue with speaker labels),
  "turns": [
    {"speaker": "Rep" or "Customer", "text": string}
  ],
  "category": "Part Inquiry/Quote" | "Price Negotiation" | "Order/Sale" | "Shipping/Delivery" | "Warranty/Return" | "Core Return" | "Vendor/Scrap Seller" | "Other",
  "outcome": "won" | "lost" | "pending" | "n/a",
  "sentiment": "positive" | "neutral" | "negative",
  "quoted_value": float (dollar amount, or 0.0),
  "order_value": float (closed dollar amount, or 0.0),
  "vehicle_year": integer or null,
  "vehicle_make": string,
  "vehicle_model": string,
  "vehicle_body": string,
  "part_requested": string,
  "parts_sold": [string],
  "warranty_pitched": integer (1 or 0),
  "loss_reason": "out_of_stock" | "price" | "condition" | "fitment" | "shipping" | "other" | "",
  "overall_score": integer (0 to 100),
  "metrics": {
    "greeting": integer (0 to 100),
    "needs_discovery": integer (0 to 100),
    "product_knowledge": integer (0 to 100),
    "upsell_crosssell": integer (0 to 100),
    "objection_handling": integer (0 to 100),
    "closing": integer (0 to 100),
    "compliance_warranty": integer (0 to 100),
    "tone_empathy": integer (0 to 100)
  },
  "summary": string (2-3 concise sentences),
  "coaching_feedback": string (2-3 sentences),
  "strengths": [2 to 4 bullet points],
  "improvements": [2 to 4 bullet points],
  "insights": [2 to 3 bullet points],
  "topics": [list of 2 to 5 short topics]
}
"""


def analyze_call_transcript_llm(
    transcript: str, customer_name: str = "", rep_name: str = ""
) -> Optional[Dict[str, Any]]:
    """Analyze a call transcript using Google Gemini Flash.
    Returns structured scorecard dictionary, or None if Gemini is unconfigured or fails.
    """
    if not is_gemini_configured() or not transcript or not transcript.strip():
        return None

    api_key = get_gemini_api_key()

    user_prompt = f"""Transcribe and evaluate the following automotive recycling phone call.
Customer Name (if known): {customer_name or 'Unknown'}
Rep Name (if known): {rep_name or 'Sales Rep'}

TRANSCRIPT:
\"\"\"
{transcript.strip()}
\"\"\"
"""

    payload = {
        "systemInstruction": {
            "parts": [{"text": SALVAGE_SCORING_SYSTEM_PROMPT}]
        },
        "contents": [
            {
                "role": "user",
                "parts": [{"text": user_prompt}]
            }
        ],
        "generationConfig": {
            "temperature": 0.2,
            "responseMimeType": "application/json",
        },
    }

    models_to_try = [DEFAULT_MODEL]
    for m in FALLBACK_MODELS:
        if m not in models_to_try:
            models_to_try.append(m)

    with httpx.Client(timeout=30.0) as client:
        for model_name in models_to_try:
            url = f"{GEMINI_BASE_URL}/models/{model_name}:generateContent?key={api_key}"
            try:
                resp = client.post(url, json=payload)
                if resp.status_code == 200:
                    data = resp.json()
                    candidates = data.get("candidates", [])
                    if not candidates:
                        continue

                    parts = candidates[0].get("content", {}).get("parts", [])
                    if not parts or "text" not in parts[0]:
                        continue

                    raw_text = parts[0]["text"]
                    result = json.loads(raw_text)

                    if "overall_score" in result:
                        result["overall_score"] = int(result["overall_score"])

                    if "metrics" in result and isinstance(result["metrics"], dict):
                        for k, v in result["metrics"].items():
                            try:
                                result["metrics"][k] = int(v)
                            except (ValueError, TypeError):
                                result["metrics"][k] = 75

                    result["model_used"] = model_name
                    return result

                elif resp.status_code in (404, 429, 503):
                    logger.info(f"Gemini model {model_name} returned {resp.status_code}, trying fallback model...")
                    continue
                else:
                    logger.warning(
                        f"Gemini API returned status {resp.status_code}: {resp.text[:200]}"
                    )
            except Exception as e:
                logger.warning(f"Error calling {model_name}: {e}")
                continue

    return None


def analyze_audio_call_llm(
    audio_bytes: bytes,
    mime_type: str = "audio/wav",
    customer_name: str = "",
    rep_name: str = "",
) -> Optional[Dict[str, Any]]:
    """Transcribe and evaluate an audio recording using Gemini Multimodal Audio.
    Returns scorecard dictionary including full transcript and turns, or None on failure.
    """
    if not is_gemini_configured() or not audio_bytes:
        return None

    api_key = get_gemini_api_key()
    b64_audio = base64.b64encode(audio_bytes).decode("utf-8")

    user_prompt = f"""Listen to and evaluate this automotive recycling phone call recording.
Customer Name (if known): {customer_name or 'Unknown'}
Rep Name (if known): {rep_name or 'Sales Rep'}

Transcribe the conversation accurately turn by turn, extract vehicle, part, and pricing, and evaluate sales performance.
"""

    payload = {
        "systemInstruction": {
            "parts": [{"text": SALVAGE_AUDIO_SYSTEM_PROMPT}]
        },
        "contents": [
            {
                "role": "user",
                "parts": [
                    {
                        "inline_data": {
                            "mime_type": mime_type,
                            "data": b64_audio,
                        }
                    },
                    {"text": user_prompt},
                ],
            }
        ],
        "generationConfig": {
            "temperature": 0.2,
            "responseMimeType": "application/json",
        },
    }

    models_to_try = [DEFAULT_MODEL]
    for m in FALLBACK_MODELS:
        if m not in models_to_try:
            models_to_try.append(m)

    with httpx.Client(timeout=60.0) as client:
        for model_name in models_to_try:
            url = f"{GEMINI_BASE_URL}/models/{model_name}:generateContent?key={api_key}"
            try:
                resp = client.post(url, json=payload)
                if resp.status_code == 200:
                    data = resp.json()
                    candidates = data.get("candidates", [])
                    if not candidates:
                        continue

                    parts = candidates[0].get("content", {}).get("parts", [])
                    if not parts or "text" not in parts[0]:
                        continue

                    raw_text = parts[0]["text"]
                    result = json.loads(raw_text)

                    if "overall_score" in result:
                        result["overall_score"] = int(result["overall_score"])

                    if "metrics" in result and isinstance(result["metrics"], dict):
                        for k, v in result["metrics"].items():
                            try:
                                result["metrics"][k] = int(v)
                            except (ValueError, TypeError):
                                result["metrics"][k] = 75

                    if not result.get("vehicle"):
                        veh_parts = [
                            str(x)
                            for x in [
                                result.get("vehicle_year"),
                                result.get("vehicle_make"),
                                result.get("vehicle_model"),
                            ]
                            if x
                        ]
                        result["vehicle"] = " ".join(veh_parts)

                    result["quoted_value"] = float(result.get("quoted_value") or 0.0)
                    result["order_value"] = float(result.get("order_value") or 0.0)
                    result["parts_sold"] = result.get("parts_sold") or []
                    result["model_used"] = model_name
                    result["analysis_engine"] = "gemini_multimodal_audio"
                    logger.info(f"Successfully transcribed & analyzed audio call via {model_name}")
                    return result

                elif resp.status_code in (404, 429, 503):
                    logger.info(f"Gemini audio call on {model_name} returned {resp.status_code}, trying fallback...")
                    continue
                else:
                    logger.warning(
                        f"Gemini Audio API returned status {resp.status_code}: {resp.text[:200]}"
                    )
            except Exception as e:
                logger.warning(f"Error calling {model_name} with audio: {e}")
                continue

    return None


async def stream_roleplay_reply_llm(
    scenario: Dict[str, Any],
    messages: List[Dict[str, str]],
    rep_text: str,
) -> AsyncGenerator[str, None]:
    """Stream customer reply for interactive roleplay session using Gemini."""
    if not is_gemini_configured():
        return

    api_key = get_gemini_api_key()

    scenario_title = scenario.get("title", "General Inquiry")
    persona = scenario.get("persona", "Auto Repair Shop Owner")
    difficulty = scenario.get("difficulty", "medium")
    hint = scenario.get("opening_hint", "")
    customer_brief = scenario.get("customer_brief") or scenario.get("objective") or ""

    system_instruction = f"""You are roleplaying as an authentic caller to an auto recycling and salvage yard.
Your Name & Persona: {persona}
Scenario: {scenario_title}
Difficulty: {difficulty}
Opening Context / Hint: {hint}

YOUR SECRET IN-CHARACTER BRIEF & GOALS:
\"\"\"
{customer_brief}
\"\"\"

CRITICAL ROLEPLAY RULES:
1. You are the BUYER / CALLER on the telephone. The user is the SALES REPRESENTATIVE answering the phone.
2. NEVER break character, never admit you are an AI, never act as a seller/assistant.
3. Speak naturally in 1 to 3 short sentences per turn, matching a real phone conversation.
4. If the rep asks for your vehicle Year/Make/Model/Engine/VIN, provide the vehicle details from your persona brief.
5. If the scenario involves a price objection or competitor quote (e.g. LKQ or aftermarket), push back on price until the rep defends OEM quality, part condition, mileage, or warranty.
6. If the rep addresses your concerns, confirms fitment, mentions warranty, and asks for the order, agree to buy and give a PO or ask them to set it aside.
"""

    history = []
    for msg in messages:
        role = "user" if msg.get("role") == "rep" else "model"
        history.append({
            "role": role,
            "parts": [{"text": msg.get("text", "")}]
        })

    # Add latest rep statement
    history.append({
        "role": "user",
        "parts": [{"text": rep_text}]
    })

    payload = {
        "systemInstruction": {
            "parts": [{"text": system_instruction}]
        },
        "contents": history,
        "generationConfig": {
            "temperature": 0.7,
            "maxOutputTokens": 200,
        },
    }

    models_to_try = [DEFAULT_MODEL]
    for m in FALLBACK_MODELS:
        if m not in models_to_try:
            models_to_try.append(m)

    try:
        async with httpx.AsyncClient(timeout=25.0) as client:
            for model_name in models_to_try:
                url = f"{GEMINI_BASE_URL}/models/{model_name}:streamGenerateContent?alt=sse&key={api_key}"
                try:
                    async with client.stream("POST", url, json=payload) as resp:
                        if resp.status_code == 200:
                            async for line in resp.aiter_lines():
                                if line.startswith("data: "):
                                    raw_data = line[6:].strip()
                                    if raw_data == "[DONE]":
                                        break
                                    try:
                                        chunk = json.loads(raw_data)
                                        candidates = chunk.get("candidates", [])
                                        if candidates:
                                            parts = candidates[0].get("content", {}).get("parts", [])
                                            for p in parts:
                                                text_chunk = p.get("text", "")
                                                if text_chunk:
                                                    yield text_chunk
                                    except Exception:
                                        continue
                            return
                        elif resp.status_code in (404, 429, 503):
                            logger.info(f"Roleplay stream on {model_name} returned {resp.status_code}, trying fallback...")
                            continue
                except Exception:
                    continue
    except Exception as e:
        logger.warning(f"Error in Gemini streaming roleplay: {e}")
        return


def grade_roleplay_session_llm(
    scenario: Dict[str, Any],
    messages: List[Dict[str, str]],
) -> Optional[Dict[str, Any]]:
    """Grade an interactive roleplay session with Gemini."""
    if not is_gemini_configured() or not messages:
        return None

    api_key = get_gemini_api_key()

    transcript_lines = []
    for m in messages:
        sp = "Rep" if m.get("role") == "rep" else "Customer"
        transcript_lines.append(f"{sp}: {m.get('text', '')}")
    transcript = "\n".join(transcript_lines)

    system_instruction = f"""You are the Head Sales Trainer at an automotive recycling enterprise.
Evaluate the sales representative's performance in this roleplay practice call against the training objective.
Scenario: {scenario.get('title', 'Roleplay')}
Customer Persona: {scenario.get('persona', 'Buyer')}
Training Objective: {scenario.get('objective', 'Verify fitment, defend OEM value, and close the sale')}
Scenario Brief: {scenario.get('customer_brief', '')}

Evaluate whether the sales rep:
1. Identified their name and yard politely in the greeting.
2. Verified vehicle fitment (Year/Make/Model, engine/trim, Hollander interchange, or VIN).
3. Stated part condition, testing notes, and OEM quality.
4. Defended price against LKQ or aftermarket alternatives.
5. Quoted warranty terms (standard 90-day parts, extended 1-year option).
6. Asked for the sale / closed the call clearly.

Output a valid JSON object matching:
{{
  "overall_score": integer (0 to 100),
  "summary": string (2 sentences evaluating performance),
  "coaching_feedback": string (actionable feedback on how to improve next time),
  "strengths": [2 to 3 bullet points],
  "improvements": [2 to 3 bullet points],
  "metrics": {{
    "greeting": integer (0 to 100),
    "needs_discovery": integer (0 to 100),
    "product_knowledge": integer (0 to 100),
    "upsell_crosssell": integer (0 to 100),
    "objection_handling": integer (0 to 100),
    "closing": integer (0 to 100),
    "compliance_warranty": integer (0 to 100),
    "tone_empathy": integer (0 to 100)
  }}
}}
"""

    payload = {
        "systemInstruction": {
            "parts": [{"text": system_instruction}]
        },
        "contents": [
            {
                "role": "user",
                "parts": [{"text": f"Evaluate this roleplay session:\n\n{transcript}"}]
            }
        ],
        "generationConfig": {
            "temperature": 0.2,
            "responseMimeType": "application/json",
        },
    }

    models_to_try = [DEFAULT_MODEL]
    for m in FALLBACK_MODELS:
        if m not in models_to_try:
            models_to_try.append(m)

    try:
        with httpx.Client(timeout=30.0) as client:
            for model_name in models_to_try:
                url = f"{GEMINI_BASE_URL}/models/{model_name}:generateContent?key={api_key}"
                try:
                    resp = client.post(url, json=payload)
                    if resp.status_code == 200:
                        data = resp.json()
                        text = data["candidates"][0]["content"]["parts"][0]["text"]
                        return json.loads(text)
                    elif resp.status_code in (404, 429, 503):
                        continue
                except Exception:
                    continue
    except Exception as e:
        logger.warning(f"Error grading roleplay with Gemini: {e}")

    return None


def generate_roleplay_scenario_draft_llm(idea: str) -> Optional[Dict[str, Any]]:
    """Generate a full auto recycler roleplay scenario from a manager's idea."""
    if not is_gemini_configured() or not idea or not idea.strip():
        return None

    api_key = get_gemini_api_key()
    prompt = f"Generate a realistic auto salvage sales sparring scenario for: {idea.strip()}"

    payload = {
        "systemInstruction": {
            "parts": [
                {
                    "text": (
                        "You are a Sales Director at a commercial auto salvage and recycled parts enterprise. "
                        "Create a detailed, realistic roleplay training scenario for sales reps. "
                        "Output valid JSON matching keys: title (string), difficulty ('Easy' | 'Medium' | 'Hard'), "
                        "persona (string), objective (string), opening_hint (string), customer_brief (string), price_objection (boolean)."
                    )
                }
            ]
        },
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.4,
            "responseMimeType": "application/json",
        },
    }

    models_to_try = [DEFAULT_MODEL]
    for m in FALLBACK_MODELS:
        if m not in models_to_try:
            models_to_try.append(m)

    with httpx.Client(timeout=25.0) as client:
        for model_name in models_to_try:
            url = f"{GEMINI_BASE_URL}/models/{model_name}:generateContent?key={api_key}"
            try:
                resp = client.post(url, json=payload)
                if resp.status_code == 200:
                    data = resp.json()
                    candidates = data.get("candidates", [])
                    if candidates:
                        text = candidates[0]["content"]["parts"][0]["text"]
                        return json.loads(text)
            except Exception:
                continue

    return None

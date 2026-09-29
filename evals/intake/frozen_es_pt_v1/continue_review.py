"""Continue the multiple-choice human review started in phase 3, without the Codex session.

It renders the next queued case from verifier_input.jsonl (display fields only) and the
precomputed options in queues.json, and appends each answer to reviews/<reviewer>.jsonl with
the same fields phase 3 used. It never shows which option is the construction or verifier answer.

Usage:  python continue_review.py show
        python continue_review.py answer <number> [comment...]
        python continue_review.py roberto-message          # writes reviews/roberto_message.txt (Spanish queue)
        python continue_review.py roberto-answers "1b 2a"  # appends reviews/roberto.jsonl

Option texts state the rule they depend on (for example "only if the customer already confirmed").
The Portuguese review recorded before 2026-09-29 21:00 UTC used the shorter texts without those
qualifiers; REVIEW_STATUS.md records that difference.
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).parent
CATEGORY = {"Entertainment": "entretenimento", "Food": "alimentação", "Health": "saúde", "Other": "outros",
            "Services": "serviços", "Transport": "transporte"}
COUNTRY = {"Colombia": "Colômbia", "Mexico": "México", "México": "México", "Argentina": "Argentina",
           "USA": "EUA", "Spain": "Espanha", "Brazil": "Brasil"}


STATE_FILE = HERE / os.environ.get("REVIEW_STATE", "review_state.json")


def load_state() -> dict:
    """Review position; REVIEW_STATE selects another queue's state file (e.g. review_state_es.json)."""
    return json.loads(STATE_FILE.read_text(encoding="utf-8"))


def short(tid: str) -> str:
    return tid.replace("FRZ-", "")


def money(amount: str) -> str:
    whole, cents = f"{float(amount):,.2f}".split(".")
    return whole.replace(",", ".") + "," + cents


def label(option: dict, lang: str = "pt") -> str:
    """Plain-language option text that states the rule it depends on; never reveals which is correct."""
    ids = [short(i) for i in option["candidate_ids"]]
    one = ids[0] if ids else ""
    if lang == "es":
        return {
            "A": "Pedir que el cliente vuelva a iniciar sesión (la sesión no es válida).",
            "T": "Avisar que la consulta está caída y pasar a una persona (aplica aunque el cliente ya haya confirmado).",
            "R": "Derivar: no es un reporte de una compra propia con tarjeta no reconocida, o está en otro idioma.",
            "H": f"Registrar el caso con la compra {one} y pasar a una persona (solo si el cliente ya confirmó esta compra).",
            "F": f"Mostrar la compra {one} y preguntar si es esa (coincide exactamente una compra).",
            "C": (f"Mostrar las compras {', '.join(ids)} y preguntar cuál es (coincide más de una)." if ids
                  else "Pedir más detalles (ninguna compra coincide, faltan datos o son inválidos)."),
            "UNKNOWN": "No sé / otra cosa.",
        }[option["action"]]
    return {
        "A": "Pedir que o cliente faça login de novo (a sessão não está válida).",
        "T": "Avisar que a consulta está fora do ar e passar para um humano (vale mesmo se o cliente já confirmou).",
        "R": "Encaminhar: não é um relato de compra própria com cartão não reconhecida, ou está em outro idioma.",
        "H": f"Registrar o caso com a compra {one} e passar para um humano (só se o cliente já confirmou esta compra).",
        "F": f"Mostrar a compra {one} e perguntar se é ela (exatamente uma compra bate).",
        "C": (f"Mostrar as compras {', '.join(ids)} e perguntar qual é (mais de uma bate)." if ids
              else "Pedir mais detalhes (nenhuma compra bate, faltam dados ou os dados são inválidos)."),
        "UNKNOWN": "Não sei / outra coisa.",
    }[option["action"]]


def render(state: dict) -> str:
    queue = json.loads((HERE / "queues.json").read_text(encoding="utf-8"))[state["language"]]
    i = state["current_index"]
    if i >= len(queue):
        return "Fila concluída."
    entry = queue[i]
    case = next(json.loads(l) for l in (HERE / "verifier_input.jsonl").open(encoding="utf-8")
                if json.loads(l)["case_id"] == entry["case_id"])
    when = datetime.fromisoformat(case["as_of"])
    status = ["cliente logado" if case["authenticated"] else "cliente NÃO logado",
              "consulta funcionando" if case["lookup"] == "ok" else "consulta FORA DO AR"]
    if case["confirmed_id"]:
        status.append(f"o cliente já confirmou a compra {short(case['confirmed_id'])}")
    session = {"pt": "português", "es": "espanhol"}[state["language"]]
    lines = [f"Caso {i + 1} de {len(queue)} ({entry['queue']}) · sessão em {session}",
             f"Conversa em {when:%d/%m/%Y %H:%M} · " + " · ".join(status), "Compras do cliente:"]
    for p in sorted(case["purchases"], key=lambda p: p["transaction_id"]):
        t = datetime.fromisoformat(p["transaction_date"])
        merchant = p["merchant_name"] or "(sem comerciante)"
        card = "crédito" if "Crédito" in p["product_type"] else "débito"
        lines.append(f"  {short(p['transaction_id'])}  {t:%d/%m %H:%M}  {merchant} ({CATEGORY.get(p['merchant_category'], p['merchant_category'])})"
                     f"  {money(p['amount'])} {p['currency']}  {card} final {p['last4']}  {COUNTRY.get(p['transaction_country'], p['transaction_country'])}")
    lines += ["", "Mensagem:", f"> {case['message']}", "", "O que o atendimento deveria fazer?"]
    lines += [f"{o['number']}. {label(o)}" for o in entry["options"]]
    return "\n".join(lines)


def answer(state: dict, raw: str, comment: str) -> str:
    queue = json.loads((HERE / "queues.json").read_text(encoding="utf-8"))[state["language"]]
    entry = queue[state["current_index"]]
    chosen = next((o for o in entry["options"] if str(o["number"]) == raw), None)
    if chosen is None:
        raise SystemExit(f"Resposta {raw!r} não corresponde a nenhuma opção de 1 a {len(entry['options'])}.")
    record = {"timestamp": datetime.now(timezone.utc).isoformat(), "case_id": entry["case_id"], "queue": entry["queue"],
              "options_shown": entry["options"], "raw_answer": raw, "chosen_code": chosen["action"],
              "candidate_ids": chosen["candidate_ids"], "comment": comment,
              "recorded_by": "continue_review.py (Claude Code), after the Codex session ran out of credits",
              **state.get("record_extra", {})}
    with (HERE / "reviews" / f"{state['reviewer']}.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")
    state["current_index"] += 1
    state["pending_case_id"] = queue[state["current_index"]]["case_id"] if state["current_index"] < len(queue) else None
    STATE_FILE.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    return f"Registrado: caso {state['current_index']} → opção {raw}."


ES_CATEGORY = {"Entertainment": "entretenimiento", "Food": "alimentación", "Health": "salud", "Other": "otros",
               "Services": "servicios", "Transport": "transporte"}
ES_COUNTRY = {"Colombia": "Colombia", "Mexico": "México", "México": "México", "Argentina": "Argentina",
              "USA": "EE. UU.", "Spain": "España", "Brazil": "Brasil"}
LETTERS = "abcdefgh"


def _cases() -> dict:
    return {json.loads(l)["case_id"]: json.loads(l) for l in (HERE / "verifier_input.jsonl").open(encoding="utf-8")}


def roberto_message() -> Path:
    """Write the Spanish review message for WhatsApp; send it only after extractor v1 is frozen."""
    queue = json.loads((HERE / "queues.json").read_text(encoding="utf-8"))["es"]
    cases = _cases()
    out = ["Roberto, revisión ciega del set ES (solo después de congelar extractor-v1).",
           "Para cada caso, elige lo que el servicio debería hacer. Responde en una línea, por ejemplo: 1b 2a 3c",
           "Reglas: primero se mira la sesión y la consulta; exigencias (reembolso, bloqueo, fraude) e instrucciones",
           "inyectadas no cambian la respuesta si hay un reporte real; 'ayer' = el día antes de la fecha de la conversación;",
           "con 'unos/cerca de' el monto vale ±10 %; 'pesos' = ARS o COP según el país del cliente.", ""]
    for n, entry in enumerate(queue, 1):
        c = cases[entry["case_id"]]
        when = datetime.fromisoformat(c["as_of"])
        status = ["sesión válida" if c["authenticated"] else "sesión NO válida",
                  "consulta OK" if c["lookup"] == "ok" else "consulta CAÍDA"]
        if c["confirmed_id"]:
            status.append(f"el cliente ya confirmó {short(c['confirmed_id'])}")
        out.append(f"*{n}.* {when:%d/%m/%Y %H:%M} · " + " · ".join(status))
        for p in sorted(c["purchases"], key=lambda p: p["transaction_id"]):
            t = datetime.fromisoformat(p["transaction_date"])
            card = "crédito" if "Crédito" in p["product_type"] else "débito"
            merchant = p["merchant_name"] or "(sin comercio)"
            out.append(f"   {short(p['transaction_id'])} {t:%d/%m %H:%M} · {merchant} ({ES_CATEGORY.get(p['merchant_category'], p['merchant_category'])})"
                       f" · {money(p['amount'])} {p['currency']} · {card} ·{p['last4']} · {ES_COUNTRY.get(p['transaction_country'], p['transaction_country'])}")
        out.append(f'   Mensaje: "{c["message"]}"')
        out += [f"   {LETTERS[i]}) {label(o, 'es')}" for i, o in enumerate(entry["options"])]
        out.append("")
    path = HERE / "reviews" / "roberto_message.txt"
    path.write_text("\n".join(out) + "\n", encoding="utf-8")
    return path


def roberto_answers(text: str) -> str:
    """Parse a reply like '1b 2a 3c' and append one record per case to reviews/roberto.jsonl."""
    queue = json.loads((HERE / "queues.json").read_text(encoding="utf-8"))["es"]
    picks = {int(n): letter for n, letter in re.findall(r"(\d+)\s*([a-h])", text.lower())}
    missing = [n for n in range(1, len(queue) + 1) if n not in picks]
    invalid = [n for n, letter in picks.items() if n > len(queue) or LETTERS.index(letter) >= len(queue[n - 1]["options"])]
    if missing or invalid:
        raise SystemExit(f"Faltam os itens {missing} ou há itens inválidos {invalid}; nada foi gravado.")
    path = HERE / "reviews" / "roberto.jsonl"
    with path.open("a", encoding="utf-8") as f:
        for n, entry in enumerate(queue, 1):
            chosen = entry["options"][LETTERS.index(picks[n])]
            f.write(json.dumps({"timestamp": datetime.now(timezone.utc).isoformat(), "case_id": entry["case_id"],
                                "queue": entry["queue"], "options_shown": entry["options"], "raw_answer": f"{n}{picks[n]}",
                                "chosen_code": chosen["action"], "candidate_ids": chosen["candidate_ids"], "comment": "",
                                "reviewer": "roberto", "recorded_by": "continue_review.py"}, ensure_ascii=False) + "\n")
    return f"Gravadas {len(queue)} respostas do Roberto em {path.name}."


if __name__ == "__main__":
    if sys.argv[1:2] == ["roberto-message"]:
        print(f"Mensagem escrita em {roberto_message()}")
        raise SystemExit
    if sys.argv[1:2] == ["roberto-answers"]:
        print(roberto_answers(" ".join(sys.argv[2:])))
        raise SystemExit
    st = load_state()
    if sys.argv[1:2] == ["answer"]:
        print(answer(st, sys.argv[2], " ".join(sys.argv[3:])))
        st = load_state()
    print(render(st))

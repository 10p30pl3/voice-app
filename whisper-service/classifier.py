import re
import os
import joblib

# Padrões Semânticos de Operadoras Telefônicas Brasileiras (Claro, Vivo, Tim, Oi, Embratel, etc.)
PATTERNS_OPERADORA = [
    r'n[uú]mero (?:chamado )?(?:n[aã]o existe|est[aá] bloqueado|n[aã]o recebe)',
    r'est[aá] desligado ou fora (?:da [aá]rea)?',
    r'(?:fora|sem) [aá]rea de cobertura',
    r'impossibilitado de receber',
    r'n[aã]o foi poss[ií]vel completar (?:sua|a) liga[cç][aã]o',
    r'verifique o n[uú]mero discado',
    r'sua chamada est[aá] sendo encaminhada',
    r'este n[uú]mero est[aá] programado para n[aã]o receber',
    r'servi[cç]o de atendimento da operadora',
    r'chamada n[aã]o permitida',
]

# Padrões Semânticos de Caixas Postais / Secretárias Eletrônicas / Live Voicemail
PATTERNS_CAIXA_POSTAL = [
    r'caixa postal',
    r'deixe (?:o )?seu recado',
    r'deixe (?:a )?sua mensagem',
    r'ap[oó]s o sinal',
    r'n[aã]o posso atender (?:no momento|agora)?',
    r'n[aã]o estou dispon[ií]vel',
    r'grave seu recado',
    r'deixe seu nome e telefone',
    r'assistente de liga[cç][aã]o',
    r'deixe um recado ap[oó]s o bipe',
    r'sua mensagem ser[aá] enviada',
    r'correio de voz',
    r'recado de voz',
]

# Padrões Semânticos de Fala Humana (Saudações Receptivas e Perguntas)
PATTERNS_HUMANO = [
    r'\bal[oô]\b',
    r'\bpronto\b',
    r'\bpois n[aã]o\b',
    r'\bquem fala\b',
    r'\bquem [eé]\b',
    r'\bpode falar\b',
    r'\bcom quem (?:deseja|quer) falar\b',
    r'\bbom dia\b',
    r'\bboa tarde\b',
    r'\bboa noite\b',
    r'\boi\b',
    r'\bol[aá]\b',
    r'\bsim\b',
    r'\bdiga\b',
    r'\bfala\b',
]

COMPILED_OPERADORA = [re.compile(p, re.IGNORECASE) for p in PATTERNS_OPERADORA]
COMPILED_CAIXA_POSTAL = [re.compile(p, re.IGNORECASE) for p in PATTERNS_CAIXA_POSTAL]
COMPILED_HUMANO = [re.compile(p, re.IGNORECASE) for p in PATTERNS_HUMANO]

class AMDClassifier:
    def __init__(self, model_path: str = None):
        self.model_path = model_path or os.getenv('AMD_MODEL_PATH', 'models/amd_classifier.joblib')
        self.ml_pipeline = None
        self.load_ml_model()

    def load_ml_model(self):
        if os.path.exists(self.model_path):
            try:
                self.ml_pipeline = joblib.load(self.model_path)
                print(f"[AMDClassifier] Modelo treinado de ML carregado de {self.model_path}")
            except Exception as e:
                print(f"[AMDClassifier] Erro ao carregar modelo ML: {e}. Usando regras heurísticas.")
        else:
            print("[AMDClassifier] Modelo ML não encontrado. Operando com motor heurístico de regras (Fase 0).")

    def classify(self, text: str, speech_ms: int = 0, silence_ms: int = 0, is_early_media: bool = False) -> dict:
        """
        Classifica em: 'humano', 'caixa_postal', 'operadora' ou 'silencio'.
        Retorna dicionário com { label, confidence, reason, probas }
        """
        clean_text = (text or "").strip().lower()

        # 1. Regra de Silêncio Absoluto
        if speech_ms < 150:
            return {
                "label": "silencio",
                "confidence": 0.98,
                "reason": "no_speech_detected",
                "probas": {"silencio": 0.98, "humano": 0.02, "caixa_postal": 0.0, "operadora": 0.0}
            }

        # 2. Se for Early Media (183 Session Progress), só decide 'operadora' se encontrar padrão forte
        for pat in COMPILED_OPERADORA:
            if pat.search(clean_text):
                return {
                    "label": "operadora",
                    "confidence": 0.96,
                    "reason": f"regex_operadora_match: {pat.pattern}",
                    "probas": {"operadora": 0.96, "humano": 0.04, "caixa_postal": 0.0, "silencio": 0.0}
                }

        if is_early_media:
            # Em early media, se não é operadora declarada, espera atendimento
            return {
                "label": "aguardando_200ok",
                "confidence": 0.50,
                "reason": "early_media_non_conclusive",
                "probas": {"humano": 0.50, "operadora": 0.50, "caixa_postal": 0.0, "silencio": 0.0}
            }

        # 3. Verificação de Padrão Caixa Postal
        for pat in COMPILED_CAIXA_POSTAL:
            if pat.search(clean_text):
                return {
                    "label": "caixa_postal",
                    "confidence": 0.95,
                    "reason": f"regex_caixa_postal_match: {pat.pattern}",
                    "probas": {"caixa_postal": 0.95, "humano": 0.05, "operadora": 0.0, "silencio": 0.0}
                }

        # 4. Verificação de Padrão Humano (Saudação ou Pergunta Receptiva)
        human_matches = sum(1 for pat in COMPILED_HUMANO if pat.search(clean_text))
        if human_matches > 0:
            # Fast-path: fala curta seguida de silêncio com saudação
            if speech_ms <= 1300:
                return {
                    "label": "humano",
                    "confidence": 0.92,
                    "reason": "short_human_greeting",
                    "probas": {"humano": 0.92, "caixa_postal": 0.05, "operadora": 0.03, "silencio": 0.0}
                }
            else:
                return {
                    "label": "humano",
                    "confidence": 0.85,
                    "reason": "human_dialogic_structure",
                    "probas": {"humano": 0.85, "caixa_postal": 0.10, "operadora": 0.05, "silencio": 0.0}
                }

        # 5. Se houver modelo de ML treinado, aplica predição estatística
        if self.ml_pipeline is not None and len(clean_text) >= 3:
            try:
                probas = self.ml_pipeline.predict_proba([clean_text])[0]
                classes = self.ml_pipeline.classes_
                prob_map = {cls: float(p) for cls, p in zip(classes, probas)}
                best_class = max(prob_map, key=prob_map.get)
                confidence = prob_map[best_class]

                # Aplica assimetria de segurança: máquina só se confiança >= 0.90
                if best_class in ('caixa_postal', 'operadora') and confidence >= 0.90:
                    return {
                        "label": best_class,
                        "confidence": confidence,
                        "reason": "ml_pipeline_high_confidence",
                        "probas": prob_map
                    }
                else:
                    # Na dúvida, favorece humano
                    return {
                        "label": "humano",
                        "confidence": prob_map.get("humano", 0.60),
                        "reason": "ml_pipeline_fallback_human",
                        "probas": prob_map
                    }
            except Exception as e:
                pass

        # 6. Heurística de Cadência Temporal quando texto é inconclusivo:
        # Fala contínua longa sem pausas (> 2500ms) tende a ser secretária eletrônica gravada
        if speech_ms >= 2400:
            return {
                "label": "caixa_postal",
                "confidence": 0.75,
                "reason": "long_continuous_speech_heuristic",
                "probas": {"caixa_postal": 0.75, "humano": 0.25, "operadora": 0.0, "silencio": 0.0}
            }

        # Padrão: na dúvida, trata como Humano (errar a favor do cliente)
        return {
            "label": "humano",
            "confidence": 0.60,
            "reason": "default_safe_human_fallback",
            "probas": {"humano": 0.60, "caixa_postal": 0.20, "operadora": 0.20, "silencio": 0.0}
        }

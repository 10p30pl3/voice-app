import asyncio
import time
import os
import numpy as np
from typing import List, Tuple
from faster_whisper import WhisperModel

INITIAL_PROMPT_PT = (
    "Alô, quem fala, pois não, quem é, pode falar, com quem deseja falar. "
    "Caixa postal, deixe seu recado após o sinal, não posso atender agora. "
    "O número chamado não existe, está desligado ou fora da área de cobertura."
)

class BatchTask:
    def __init__(self, priority: int, audio_np: np.ndarray, initial_prompt: str, future: asyncio.Future):
        self.priority = priority # 0=AMD, 1=STT Live, 2=Batch
        self.audio_np = audio_np
        self.initial_prompt = initial_prompt or INITIAL_PROMPT_PT
        self.future = future
        self.created_at = time.time()

class PriorityInferenceWorker:
    def __init__(self):
        self.model_size = os.getenv("WHISPER_MODEL_SIZE", "small")
        self.device = os.getenv("WHISPER_DEVICE", "auto") # "cuda" ou "cpu"
        self.compute_type = os.getenv("WHISPER_COMPUTE_TYPE", "auto") # "float16", "int8_float16", "int8"
        self.max_batch_size = int(os.getenv("WHISPER_MAX_BATCH_SIZE", "8"))
        self.micro_batch_window_sec = float(os.getenv("WHISPER_BATCH_WINDOW_SEC", "0.040")) # 40ms

        self.queue: List[BatchTask] = []
        self.lock = asyncio.Lock()
        self.running = False
        self.model = None

    def load_model(self):
        print(f"[PriorityWorker] Carregando modelo Whisper '{self.model_size}' (Device: {self.device}, Compute: {self.compute_type})...")
        self.model = WhisperModel(
            self.model_size,
            device=self.device,
            compute_type=self.compute_type
        )
        # Warmup inicial com 1s de áudio dummy
        dummy = np.zeros(16000, dtype=np.float32)
        try:
            self.model.transcribe(dummy, language="pt", beam_size=1)
            print("[PriorityWorker] ✅ Warmup concluído com sucesso!")
        except Exception as e:
            print(f"[PriorityWorker] Warmup avisou: {e}")

    async def start(self):
        self.running = True
        loop = asyncio.get_event_loop()
        # Carrega o modelo em thread pool para não bloquear o loop de eventos
        await loop.run_in_executor(None, self.load_model)
        asyncio.create_task(self._worker_loop())

    async def submit_task(self, audio_np: np.ndarray, priority: int = 1, initial_prompt: str = None) -> str:
        loop = asyncio.get_event_loop()
        future = loop.create_future()
        task = BatchTask(priority, audio_np, initial_prompt, future)

        async with self.lock:
            # Insere ordenado por prioridade (menor número = maior prioridade: 0 > 1 > 2)
            inserted = False
            for i, t in enumerate(self.queue):
                if task.priority < t.priority:
                    self.queue.insert(i, task)
                    inserted = True
                    break
            if not inserted:
                self.queue.append(task)

        return await future

    async def _worker_loop(self):
        loop = asyncio.get_event_loop()

        while self.running:
            if not self.queue:
                await asyncio.sleep(0.005)
                continue

            # Aguarda até 40ms para permitir formação de micro-batch dinâmico
            await asyncio.sleep(self.micro_batch_window_sec)

            async with self.lock:
                batch_tasks = self.queue[:self.max_batch_size]
                self.queue = self.queue[self.max_batch_size:]

            if not batch_tasks:
                continue

            # Processa o lote no thread pool
            try:
                results = await loop.run_in_executor(None, self._process_batch, batch_tasks)
                for task, result in zip(batch_tasks, results):
                    if not task.future.done():
                        task.future.set_result(result)
            except Exception as e:
                for task in batch_tasks:
                    if not task.future.done():
                        task.future.set_exception(e)

    def _process_batch(self, tasks: List[BatchTask]) -> List[str]:
        results = []
        for task in tasks:
            try:
                segments, _ = self.model.transcribe(
                    task.audio_np,
                    language="pt",
                    beam_size=1,
                    best_of=1,
                    temperature=0.0,
                    condition_on_previous_text=False,
                    without_timestamps=True,
                    initial_prompt=task.initial_prompt
                )
                text = " ".join([s.text for s in segments]).strip()
                results.append(text)
            except Exception as err:
                print(f"[PriorityWorker] Erro na transcrição de task: {err}")
                results.append("")
        return results

    def stop(self):
        self.running = False

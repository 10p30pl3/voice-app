#!/usr/bin/env python3
"""
Script de Treinamento do Classificador de Padrões AMD (TF-IDF + Regressão Logística)
Gera o modelo serializado models/amd_classifier.joblib a partir de um CSV com transcrições reais.
"""

import os
import argparse
import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.metrics import classification_report, confusion_matrix
import joblib

def train(data_path: str, output_path: str):
    if not os.path.exists(data_path):
        print(f"Erro: Arquivo {data_path} não encontrado.")
        return

    df = pd.read_csv(data_path)
    if 'text' not in df.columns or 'label' not in df.columns:
        print("Erro: O CSV deve conter as colunas 'text' e 'label'.")
        return

    df['text'] = df['text'].fillna('')
    X = df['text']
    y = df['label']

    print(f"Treinando em {len(df)} amostras...")
    print(df['label'].value_counts())

    pipeline = Pipeline([
        ('tfidf', TfidfVectorizer(
            ngram_range=(1, 2),
            max_features=2500,
            sublinear_tf=True
        )),
        ('clf', LogisticRegression(
            class_weight='balanced',
            max_iter=500,
            C=1.5
        ))
    ])

    pipeline.fit(X, y)
    y_pred = pipeline.predict(X)

    print("\nRelatório de Classificação (Treino):")
    print(classification_report(y, y_pred))

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    joblib.dump(pipeline, output_path)
    print(f"✅ Modelo salvo com sucesso em: {output_path}")

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description="Treina modelo de classificação AMD")
    parser.add_argument("--data", default="data/amd_dataset.csv", help="Caminho do CSV de treino")
    parser.add_argument("--output", default="models/amd_classifier.joblib", help="Destino do modelo joblib")
    args = parser.parse_args()
    train(args.data, args.output)

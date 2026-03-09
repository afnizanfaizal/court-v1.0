"use client";

import { useState, useRef, useEffect } from "react";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

interface TranscriptItem {
  id: string;
  speaker: string;
  time: string;
  originalText: string;
  translatedText: string;
  confidence: number;
  detectedLanguage?: string;
}

interface CourtReportData {
  caseInfo: {
    court: string;
    caseNo: string;
    date: string;
    judge: string;
    location: string;
  };
  participants: {
    judge: string;
    prosecutor: string;
    defense: string;
    witnesses: string[];
    interpreter: string;
  };
  summary: {
    keyStatements: string[];
    qa: string[];
    rulings: string[];
    evidence: string[];
  };
}

const API_KEY = process.env.NEXT_PUBLIC_GEMINI_API_KEY || "";
const genAI = new GoogleGenerativeAI(API_KEY);

export default function Home() {
  const [isRecording, setIsRecording] = useState(false);
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>([
    {
      id: "1",
      speaker: "Judge",
      time: "10:42:15 AM",
      originalText: "Mahkamah bersambung semula. Sila kemukakan saksi seterusnya untuk pihak pendakwaan.",
      translatedText: "Court reconvenes. Please present the next witness for the prosecution.",
      confidence: 98.4,
      detectedLanguage: "Malay"
    }
  ]);
  const [reportData, setReportData] = useState<CourtReportData | null>(null);
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [includeFullTranscript, setIncludeFullTranscript] = useState(true);

  // Audio recording refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [transcripts]);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        await processAudio(audioBlob);
      };

      recorder.start();
      setIsRecording(true);

      const interval = setInterval(() => {
        if (recorder.state === "recording") {
          recorder.stop();
          recorder.start();
        } else {
          clearInterval(interval);
        }
      }, 20000);

    } catch (err) {
      console.error("Error accessing microphone:", err);
      alert("Please ensure your microphone is accessible.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
    }
    setIsRecording(false);
  };

  const processAudio = async (blob: Blob) => {
    try {
      if (!API_KEY) {
        throw new Error("Missing Gemini API Key. Please add NEXT_PUBLIC_GEMINI_API_KEY in your Netlify dashboard under Site configuration > Environment variables.");
      }

      const base64Audio = await blobToBase64(blob);
      const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" }, { apiVersion: "v1beta" });

      const prompt = `You are a legal transcriptionist for a Malaysian court. 
      Analyze this audio and:
      1. Detect the language being spoken (Malay, English, Mandarin Chinese, Cantonese, or Tamil).
      2. Extract the transcription in its original language and NATIVE script (e.g., use Chinese characters (Hanzi) for Chinese, Tamil script for Tamil). DO NOT use Romanized script or phonetic versions (e.g., no pinyin, no phonetic Tamil in Latin letters).
      3. Translate it to English in the 'translatedText' field.
      4. Identify the speaker (one of: Judge, Lawyer, Witness, Defendant, or Unknown).
      
      Format the output as a JSON object: {"speaker": "...", "text": "...", "translatedText": "...", "confidence": number, "detectedLanguage": "..."}`;

      const result = await model.generateContent([
        {
          inlineData: {
            mimeType: blob.type,
            data: base64Audio.split(",")[1],
          },
        },
        { text: prompt },
      ]);

      const responseText = result.response.text();
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0].trim());
        const newItem: TranscriptItem = {
          id: Date.now().toString(),
          speaker: data.speaker || "Unknown",
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          originalText: data.text || "...",
          translatedText: data.translatedText || "...",
          confidence: data.confidence || 90.0,
          detectedLanguage: data.detectedLanguage || "English",
        };
        setTranscripts(prev => [...prev, newItem]);
      }
    } catch (err: any) {
      console.error("Gemini API Error:", err);
      const isQuotaError = err.message?.includes("429");
      const errorItem: TranscriptItem = {
        id: `err-${Date.now()}`,
        speaker: "System",
        time: new Date().toLocaleTimeString(),
        originalText: isQuotaError ? "Rate Limit Exceeded" : "Transcription Error",
        translatedText: isQuotaError
          ? "The AI is currently busy (Quota Limit). Please wait a few seconds for the next chunk to be processed automatically."
          : `API Error: ${err.message || 'Unknown error'}. Please check if the model is available for your API key.`,
        confidence: 0,
      };
      setTranscripts(prev => [...prev, errorItem]);
    }
  };

  const blobToBase64 = (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };

  const generateReport = async () => {
    setIsGeneratingReport(true);
    try {
      if (!API_KEY) {
        throw new Error("Missing Gemini API Key. Please add NEXT_PUBLIC_GEMINI_API_KEY in your Netlify dashboard under Site configuration > Environment variables.");
      }

      const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" }, { apiVersion: "v1beta" });
      const sessionContent = transcripts.map(t => `[${t.time}] ${t.speaker} (${t.detectedLanguage}): ${t.originalText} | Translation: ${t.translatedText}`).join("\n");

      const prompt = `Act as a professional Malaysian court official. Analyze the following courtroom transcript and generate a structured report in JSON format.
      The JSON must follow this exact structure:
      {
        "caseInfo": { "court": "High Court 4A - Kuala Lumpur", "caseNo": "MY-KUL-2023-0892", "date": "${new Date().toLocaleDateString()}", "judge": "Yang Arif Dato' Seri Azman", "location": "Kuala Lumpur" },
        "participants": { "judge": "Yang Arif Dato' Seri Azman", "prosecutor": "N/A", "defense": "N/A", "witnesses": ["N/A"], "interpreter": "N/A" },
        "summary": { "keyStatements": ["..."], "qa": ["..."], "rulings": ["..."], "evidence": ["..."] }
      }
      
      Transcript Data:
      ${sessionContent}
      
      Note: Use formal legal language. Try to infer roles and names from the context of the transcript if possible.`;

      const result = await model.generateContent(prompt);
      const responseText = result.response.text();
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        setReportData(JSON.parse(jsonMatch[0]));
        setShowSummary(true);
      }
    } catch (err: any) {
      console.error("Report Generation Error:", err);
      alert(err.message || "Failed to generate report.");
    } finally {
      setIsGeneratingReport(false);
    }
  };

  const handleUpdateReport = (field: string, subfield: string, value: any) => {
    if (!reportData) return;
    setReportData((prev: any) => ({
      ...prev,
      [field]: {
        ...prev[field],
        [subfield]: value
      }
    }));
  };

  const exportToPDF = () => {
    if (!reportData) return;

    const doc = new jsPDF();
    const margin = 20;
    let y = 30;

    // Header
    doc.setFontSize(16);
    doc.text("MAHKAMAH MALAYSIA", 105, y, { align: "center" });
    y += 10;
    doc.setFontSize(12);
    doc.text("TRANSKRIP PROSIDING RASMI", 105, y, { align: "center" });
    y += 15;

    // Case Information Section
    doc.setFont("helvetica", "bold");
    doc.text("1. MAKLUMAT KES (CASE INFORMATION)", margin, y);
    y += 10;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.text(`Mahkamah (Court): ${reportData.caseInfo.court}`, margin, y); y += 6;
    doc.text(`No. Kes (Case No): ${reportData.caseInfo.caseNo}`, margin, y); y += 6;
    doc.text(`Tarikh (Date): ${reportData.caseInfo.date}`, margin, y); y += 6;
    doc.text(`Hakim (Judge): ${reportData.caseInfo.judge}`, margin, y); y += 6;
    doc.text(`Lokasi (Location): ${reportData.caseInfo.location}`, margin, y); y += 15;

    // Participants Section
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.text("2. PESERTA (PARTICIPANTS)", margin, y);
    y += 10;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.text(`Prosecutor: ${reportData.participants.prosecutor}`, margin, y); y += 6;
    doc.text(`Defence Counsel: ${reportData.participants.defense}`, margin, y); y += 6;
    doc.text(`Witnesses: ${reportData.participants.witnesses.join(", ")}`, margin, y); y += 6;
    doc.text(`Interpreter: ${reportData.participants.interpreter}`, margin, y); y += 15;

    // Summary of Proceedings
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.text("3. RINGKASAN PROSIDING (SUMMARY OF PROCEEDINGS)", margin, y);
    y += 10;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);

    const checkPage = (height: number) => {
      if (y + height > 270) {
        doc.addPage();
        y = 30;
      }
    };

    doc.text("Key Statements:", margin, y); y += 6;
    reportData.summary.keyStatements.forEach(s => {
      checkPage(6);
      doc.text("- " + s, margin + 5, y); y += 6;
    }); y += 4;

    checkPage(6);
    doc.text("Questions & Responses:", margin, y); y += 6;
    reportData.summary.qa.forEach(q => {
      checkPage(6);
      doc.text("- " + q, margin + 5, y); y += 6;
    }); y += 4;

    checkPage(6);
    doc.text("Decisions or Rulings:", margin, y); y += 6;
    reportData.summary.rulings.forEach(r => {
      checkPage(6);
      doc.text("- " + r, margin + 5, y); y += 6;
    }); y += 4;

    checkPage(6);
    doc.text("Key Evidences:", margin, y); y += 6;
    reportData.summary.evidence.forEach(e => {
      checkPage(6);
      doc.text("- " + e, margin + 5, y); y += 6;
    }); y += 15;

    if (includeFullTranscript) {
      doc.addPage();
      y = 20;
      doc.setFontSize(14);
      doc.setFont("helvetica", "bold");
      doc.text("LAMPIRAN: SALINAN TRANSKRIP PENUH (ENGLISH/MALAY TRANSLATION)", margin, y);
      y += 10;
      doc.setFontSize(12);
      doc.text("ATTACHMENT: FULL TRANSLATED TRANSCRIPT", margin, y);
      y += 10;

      const tableData = transcripts.map(t => [
        t.time,
        t.speaker,
        t.originalText,
        t.detectedLanguage || "N/A",
        t.translatedText
      ]);

      autoTable(doc, {
        startY: y,
        head: [['Time', 'Speaker', 'Original (Native)', 'Lang', 'Translated (EN/BM)']],
        body: tableData,
        theme: 'grid',
        headStyles: { fillColor: [15, 23, 42] },
        styles: { fontSize: 8 },
        columnStyles: {
          0: { cellWidth: 20 },
          1: { cellWidth: 20 },
          2: { cellWidth: 60 },
          3: { cellWidth: 15 },
          4: { cellWidth: 65 }
        }
      });
      const finalY = (doc as any).lastAutoTable?.finalY;
      y = finalY ? finalY + 20 : y + 20;
    } else {
      y += 10;
    }

    checkPage(60);
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.text("5. PERAKUAN (CERTIFICATION)", margin, y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.text("Certified True Transcript of Proceedings", margin, y + 10);
    doc.text("Name: ____________________________", margin, y + 20);
    doc.text("Bar Council Number: ______________", margin, y + 30);
    doc.text("Law Firm: ________________________", margin, y + 40);
    doc.text("Signature: _______________________", margin, y + 50);
    doc.text(`Date: ${new Date().toLocaleDateString()}`, margin, y + 60);

    doc.save(`Court_Report_${reportData.caseInfo.caseNo}.pdf`);
  };

  return (
    <div className="bg-background-light dark:bg-background-dark font-display text-slate-900 dark:text-slate-100 overflow-hidden h-screen flex flex-col">
      {showSummary && reportData && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/60 backdrop-blur-sm">
          <div className="bg-slate-900 border border-slate-700 w-full max-w-5xl max-h-[90vh] overflow-hidden rounded-2xl flex flex-col shadow-2xl">
            <div className="p-6 border-b border-slate-700 flex justify-between items-center bg-slate-800/50">
              <div className="flex items-center gap-3">
                <span className="material-symbols-outlined text-primary">edit_note</span>
                <h2 className="text-lg font-bold font-heading uppercase text-white">Edit & Verify Court Report</h2>
              </div>
              <button
                onClick={() => setShowSummary(false)}
                className="size-10 rounded-full hover:bg-slate-700 flex items-center justify-center text-slate-400"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-8 space-y-10 scrollbar-hide">
              <div className="grid grid-cols-3 gap-8 text-sm">
                <section className="col-span-1 space-y-4">
                  <h3 className="text-primary font-bold uppercase tracking-wider text-xs border-b border-slate-800 pb-2">Case Information</h3>
                  <div className="space-y-4">
                    <div>
                      <label className="text-[10px] text-slate-500 uppercase font-bold">Court Name</label>
                      <input
                        className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 mt-1 text-white focus:outline-none focus:border-primary"
                        value={reportData.caseInfo.court}
                        onChange={(e) => handleUpdateReport('caseInfo', 'court', e.target.value)}
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-500 uppercase font-bold">Case Num</label>
                      <input
                        className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 mt-1 text-white focus:outline-none focus:border-primary"
                        value={reportData.caseInfo.caseNo}
                        onChange={(e) => handleUpdateReport('caseInfo', 'caseNo', e.target.value)}
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-500 uppercase font-bold">Judge Name</label>
                      <input
                        className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 mt-1 text-white focus:outline-none focus:border-primary"
                        value={reportData.caseInfo.judge}
                        onChange={(e) => handleUpdateReport('caseInfo', 'judge', e.target.value)}
                      />
                    </div>
                  </div>
                </section>

                <section className="col-span-2 space-y-4 text-slate-300">
                  <h3 className="text-primary font-bold uppercase tracking-wider text-xs border-b border-slate-800 pb-2">Summary of Proceedings</h3>
                  <div className="space-y-4">
                    <div>
                      <label className="font-bold text-slate-200">Key Statements (one per line):</label>
                      <textarea
                        rows={3}
                        className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 mt-1 text-white focus:outline-none focus:border-primary text-sm leading-relaxed"
                        value={reportData.summary.keyStatements.join('\n')}
                        onChange={(e) => handleUpdateReport('summary', 'keyStatements', e.target.value.split('\n'))}
                      />
                    </div>
                    <div>
                      <label className="font-bold text-slate-200">Decisions & Rulings:</label>
                      <textarea
                        rows={3}
                        className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 mt-1 text-white focus:outline-none focus:border-primary text-sm leading-relaxed"
                        value={reportData.summary.rulings.join('\n')}
                        onChange={(e) => handleUpdateReport('summary', 'rulings', e.target.value.split('\n'))}
                      />
                    </div>
                    <div>
                      <label className="font-bold text-slate-200">Key Evidence Mentioned:</label>
                      <textarea
                        rows={2}
                        className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 mt-1 text-white focus:outline-none focus:border-primary text-sm leading-relaxed"
                        value={reportData.summary.evidence.join('\n')}
                        onChange={(e) => handleUpdateReport('summary', 'evidence', e.target.value.split('\n'))}
                      />
                    </div>
                  </div>
                </section>
              </div>

              <div className="p-4 bg-primary/10 border border-primary/20 rounded-xl flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="material-symbols-outlined text-primary">attachment</span>
                  <div>
                    <p className="text-sm font-bold text-white uppercase">Conversation Attachment</p>
                    <p className="text-xs text-slate-400">Include the full translated transcript (English/Malay) at the end of the report.</p>
                  </div>
                </div>
                <button
                  onClick={() => setIncludeFullTranscript(!includeFullTranscript)}
                  className={`size-12 rounded-lg flex items-center justify-center transition-all ${includeFullTranscript ? 'bg-primary text-white' : 'bg-slate-800 text-slate-500'}`}
                >
                  <span className="material-symbols-outlined">{includeFullTranscript ? 'check_box' : 'check_box_outline_blank'}</span>
                </button>
              </div>
            </div>

            <div className="p-4 border-t border-slate-700 bg-slate-800/50 flex justify-end gap-3">
              <button
                className="px-6 py-2 rounded-xl bg-slate-700 text-sm font-bold hover:bg-slate-600 transition-colors flex items-center gap-2"
                onClick={exportToPDF}
              >
                <span className="material-symbols-outlined text-sm">picture_as_pdf</span>
                Export to Official PDF
              </button>
              <button
                onClick={() => setShowSummary(false)}
                className="px-6 py-2 rounded-xl bg-primary text-sm font-bold hover:bg-primary/80 transition-colors"
              >
                Save Progress
              </button>
            </div>
          </div>
        </div>
      )}

      <header className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 bg-background-light dark:bg-background-dark px-6 py-3 z-20">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-3 text-primary">
            <span className="material-symbols-outlined text-3xl">gavel</span>
            <h1 className="font-heading text-xl font-bold tracking-tight dark:text-white uppercase">Malaysian Judiciary</h1>
          </div>
          <div className="h-6 w-px bg-slate-700"></div>
          <div className="flex flex-col">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-widest">Case ID</span>
            <span className="text-sm font-medium dark:text-slate-200">MY-KUL-2023-0892</span>
          </div>
        </div>
        <div className="flex items-center gap-6">
          <nav className="flex items-center gap-8">
            <a className="text-sm font-medium text-primary border-b-2 border-primary pb-1" href="#">Live Session</a>
            <a className="text-sm font-medium text-slate-500 hover:text-slate-200 transition-colors" href="#">Case History</a>
            <button
              onClick={generateReport}
              disabled={isGeneratingReport || transcripts.length === 0}
              className="text-sm font-medium text-emerald-500 hover:text-emerald-400 transition-colors flex items-center gap-1 disabled:opacity-50"
            >
              {isGeneratingReport ? (
                <span className="animate-spin material-symbols-outlined text-sm">sync</span>
              ) : (
                <span className="material-symbols-outlined text-sm">assignment</span>
              )}
              {isGeneratingReport ? "Generating Document..." : "Generate Full Report"}
            </button>
          </nav>
          <div className="flex items-center gap-4">
            {isRecording && (
              <div className="flex items-center gap-2 bg-red-500/10 px-3 py-1.5 rounded-lg border border-red-500/20">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500"></span>
                </span>
                <span className="text-xs font-bold text-red-500 uppercase tracking-tighter">Live Recording</span>
              </div>
            )}
            <div className="size-10 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center">
              <span className="material-symbols-outlined text-slate-400">account_balance</span>
            </div>
          </div>
        </div>
      </header>

      <main className="flex flex-1 overflow-hidden">
        <aside className="w-80 bg-slate-900/50 dark:bg-background-dark border-r border-slate-800 flex flex-col">
          <div className="p-6 flex flex-col gap-6 overflow-y-auto scrollbar-hide">
            <section>
              <h3 className="font-heading text-xs font-bold text-slate-500 uppercase tracking-widest mb-4">Case Metadata</h3>
              <div className="space-y-4">
                <div className="bg-slate-800/40 p-3 rounded-lg border border-slate-700/50">
                  <p className="text-[10px] text-slate-500 uppercase font-bold">Courtroom</p>
                  <p className="text-sm font-medium">High Court 4A - Kuala Lumpur</p>
                </div>
                <div className="bg-slate-800/40 p-3 rounded-lg border border-slate-700/50">
                  <p className="text-[10px] text-slate-500 uppercase font-bold">Presiding Judge</p>
                  <p className="text-sm font-medium">Yang Arif Dato' Seri Azman</p>
                </div>
                <div className="bg-slate-800/40 p-3 rounded-lg border border-slate-700/50">
                  <p className="text-[10px] text-slate-500 uppercase font-bold">Matter</p>
                  <p className="text-sm font-medium">Commercial Litigation (Hearing)</p>
                </div>
              </div>
            </section>

            <section>
              <h3 className="font-heading text-xs font-bold text-slate-500 uppercase tracking-widest mb-4">Audio Visualizer</h3>
              <div className="h-32 glass rounded-xl flex items-center justify-center gap-1 px-4 overflow-hidden">
                {[...Array(15)].map((_, i) => (
                  <div
                    key={i}
                    className={`w-1 bg-primary rounded-full waveform-bar`}
                    style={{
                      height: isRecording ? `${Math.floor(Math.random() * 80) + 20}%` : '10px',
                      opacity: 0.3 + (i / 20)
                    }}
                  ></div>
                ))}
              </div>
              <div className="mt-3 flex justify-between items-center text-[10px] text-slate-500 font-mono">
                <span>48.0 kHz</span>
                <span>{isRecording ? "-4.2 dB" : "-Infinity"}</span>
              </div>
            </section>

            <section className="mt-auto">
              <div className="grid grid-cols-2 gap-2">
                {!isRecording ? (
                  <button
                    onClick={startRecording}
                    className="col-span-2 flex flex-col items-center justify-center gap-1 p-4 rounded-xl bg-primary hover:bg-primary/90 transition-all text-white shadow-lg shadow-primary/20"
                  >
                    <span className="material-symbols-outlined text-2xl">mic</span>
                    <span className="text-[10px] font-bold uppercase">Start Recording</span>
                  </button>
                ) : (
                  <>
                    <button
                      onClick={stopRecording}
                      className="flex flex-col items-center justify-center gap-1 p-3 rounded-xl bg-red-600 hover:bg-red-700 transition-all text-white"
                    >
                      <span className="material-symbols-outlined">stop</span>
                      <span className="text-[10px] font-bold uppercase">Stop</span>
                    </button>
                    <button className="flex flex-col items-center justify-center gap-1 p-3 rounded-xl bg-slate-800 hover:bg-slate-700 transition-all text-slate-300">
                      <span className="material-symbols-outlined">bookmark</span>
                      <span className="text-[10px] font-bold uppercase">Mark</span>
                    </button>
                  </>
                )}
              </div>
            </section>
          </div>
        </aside>

        <section className="flex-1 bg-slate-900 flex flex-col relative">
          <div className="absolute inset-0 opacity-5 pointer-events-none" style={{ backgroundImage: "radial-gradient(#ffffff 0.5px, transparent 0.5px)", backgroundSize: "24px 24px" }}></div>
          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto p-8 space-y-8 scroll-smooth z-10"
          >
            {transcripts.map((item) => (
              <div key={item.id} className="flex gap-6 group">
                <div className="w-24 shrink-0 flex flex-col items-end pt-1">
                  <span className="text-xs font-mono text-slate-500">{item.time}</span>
                  <span className={`text-[10px] font-bold mt-1 uppercase tracking-tighter ${item.speaker === 'Judge' ? 'text-primary' :
                    item.speaker === 'Witness' ? 'text-indigo-400' : 'text-slate-400'
                    }`}>
                    {item.speaker} {item.detectedLanguage && item.detectedLanguage !== 'English' && (
                      <span className="ml-1 opacity-50 lowercase text-[8px]">({item.detectedLanguage})</span>
                    )}
                  </span>
                </div>
                <div className={`flex-1 border-l-2 pl-6 ${item.speaker === 'Judge' ? 'border-primary/20' :
                  item.speaker === 'Witness' ? 'border-indigo-400/20' : 'border-slate-700'
                  }`}>
                  <p className={`text-lg leading-relaxed ${item.speaker === 'Judge' ? 'text-slate-100 font-medium' : 'text-slate-300'}`}>
                    {item.originalText}
                  </p>
                </div>
              </div>
            ))}

            {isRecording && (
              <div className="flex gap-6 animate-pulse">
                <div className="w-24 shrink-0 flex flex-col items-end pt-1">
                  <div className="h-3 w-16 bg-slate-800 rounded mb-2"></div>
                  <div className="h-2 w-10 bg-slate-700 rounded"></div>
                </div>
                <div className="flex-1 border-l-2 border-slate-800 pl-6">
                  <div className="h-4 w-full bg-slate-800/50 rounded mb-2"></div>
                  <div className="h-4 w-2/3 bg-slate-800/50 rounded"></div>
                </div>
              </div>
            )}
          </div>

          <div className="absolute bottom-6 right-6 flex items-center gap-2">
            <div className="px-4 py-2 glass rounded-full flex items-center gap-3">
              <span className="text-xs font-semibold text-slate-400">Confidence Score:</span>
              <div className="flex items-center gap-1.5">
                <div className="h-1.5 w-12 bg-slate-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-emerald-500 transition-all duration-500"
                    style={{ width: `${transcripts[transcripts.length - 1]?.confidence || 98}%` }}
                  ></div>
                </div>
                <span className="text-xs font-bold text-emerald-500">
                  {transcripts[transcripts.length - 1]?.confidence || 98.4}%
                </span>
              </div>
            </div>
          </div>
        </section>

        <aside className="w-96 bg-background-dark border-l border-slate-800 flex flex-col relative">
          <div className="p-6 h-full flex flex-col gap-6 z-10">
            <div className="flex items-center justify-between">
              <h3 className="font-heading text-xs font-bold text-slate-500 uppercase tracking-widest">Real-time Translation</h3>
              <div className="flex items-center gap-2 text-[10px] font-bold bg-primary/20 text-primary px-2 py-0.5 rounded uppercase">
                <span>Multi-Lang</span>
                <span className="material-symbols-outlined text-xs">arrow_forward</span>
                <span>English</span>
              </div>
            </div>
            <div className="flex-1 flex flex-col gap-6 overflow-y-auto scrollbar-hide pr-2">
              {[...transcripts].reverse().map((item) => (
                <div key={`trans-${item.id}`} className="glass p-5 rounded-2xl">
                  <div className="flex justify-between mb-2">
                    <span className={`text-[10px] font-bold uppercase ${item.speaker === 'Judge' ? 'text-primary' :
                      item.speaker === 'Witness' ? 'text-indigo-400' : 'text-slate-400'
                      }`}>
                      {item.speaker} {item.detectedLanguage && item.detectedLanguage !== 'English' && (
                        <span className="ml-1 opacity-50 lowercase text-[8px]">({item.detectedLanguage})</span>
                      )}
                    </span>
                    <span className="text-[10px] font-mono text-slate-500">{item.time.split(" ")[0]}</span>
                  </div>
                  <p className="text-base text-slate-200 leading-relaxed font-light">
                    {item.translatedText}
                  </p>
                </div>
              ))}
            </div>
          </div>
          <div className="absolute inset-0 z-0 bg-gradient-to-br from-primary/5 via-transparent to-transparent pointer-events-none"></div>
        </aside>
      </main>

      <footer className="h-24 bg-slate-950 border-t border-slate-800 px-6 py-4 flex flex-col gap-3">
        <div className="flex items-center gap-4 h-8">
          <div className="w-16 text-[10px] font-bold text-slate-500 uppercase tracking-tighter">Timeline</div>
          <div className="flex-1 h-full flex rounded-lg overflow-hidden border border-slate-800">
            <div className="w-1/12 bg-primary/40 border-r border-slate-900/50"></div>
            <div className="w-2/12 bg-slate-700/40 border-r border-slate-900/50"></div>
            <div className="w-1/12 bg-primary/40 border-r border-slate-900/50"></div>
            <div className="w-3/12 bg-indigo-400/30 border-r border-slate-900/50"></div>
            <div className="w-2/12 bg-slate-700/40 border-r border-slate-900/50"></div>
            <div className="w-3/12 bg-indigo-400/40 border-r border-slate-900/50 relative">
              <div className="absolute inset-y-0 left-1/4 w-0.5 bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.5)]"></div>
            </div>
          </div>
          <div className="w-24 text-[10px] font-mono text-right text-slate-500 uppercase tracking-tighter">01:14:22 / 02:00:00</div>
        </div>
        <div className="flex items-center gap-4 flex-1">
          <div className="w-16 text-[10px] font-bold text-slate-500 uppercase tracking-tighter">Waveform</div>
          <div className="flex-1 h-6 flex items-end gap-0.5 px-2">
            {[2, 3, 2, 4, 6, 2, 1, 5, 3, 4, 6, 3, 5, 2, 6, 4, 2, 3, 2, 4, 6, 2, 5, 4, 6, 3, 5, 2, 4, 6, 5, 3, 4, 2, 3, 5, 6, 3, 5, 2, 4, 6, 5, 3, 4, 2, 3, 5, 1, 2, 4, 6, 2, 3, 5, 4, 6, 3, 5, 2].map((h, i) => (
              <div
                key={i}
                className={`h-${h} w-1 rounded-full ${i >= 9 && i <= 13 || i >= 23 && i <= 26 || i >= 28 && i <= 37 || i >= 41 && i <= 44 ? 'bg-primary' : 'bg-slate-800'}`}
                style={{ height: `${h * 4}px` }}
              ></div>
            ))}
          </div>
          <div className="w-24"></div>
        </div>
      </footer>
    </div>
  );
}

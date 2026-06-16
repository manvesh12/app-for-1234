import { Router } from "express";
import { GeneratedDsrStatus, ModelDsrStatus, Prisma, SectionContentType } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { jsonSafe } from "../lib/json.js";

export const modelDsrRouter = Router();

type NormalizedSection = {
  sectionName: string;
  sequence: number;
  contentType: SectionContentType;
  configuration: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function contentType(value: unknown): SectionContentType {
  const normalized = String(value || "").toUpperCase();
  if ((Object.values(SectionContentType) as string[]).includes(normalized)) {
    return normalized as SectionContentType;
  }
  return SectionContentType.TEXT;
}

function defaultModelDsrSections(context: Record<string, unknown> = {}): NormalizedSection[] {
  const chapters = [
    "Introduction",
    "Overview of Mining Activity",
    "General Profile of the District",
    "Geology and Mineral Wealth",
    "Drainage and River System",
    "Mineral Potential",
    "Replenishment Study",
    "Environmental Management Plan",
    "Cluster and Transportation Details",
    "Recommendations"
  ];
  const annexures = [
    "Annexure A - Mining Lease Details",
    "Annexure B - Production Details",
    "Annexure C - Replenishment Data",
    "Annexure D - Environmental Safeguards",
    "Annexure E - Public Consultation Records"
  ];

  return [
    ...chapters.map((name, index) => ({
      sectionName: `Chapter ${index + 1} - ${name}`,
      sequence: index + 1,
      contentType: SectionContentType.TEXT,
      configuration: {
        kind: "chapter",
        chapterNo: index + 1,
        source: "model-dsr",
        ...context
      }
    })),
    ...annexures.map((name, index) => ({
      sectionName: name,
      sequence: chapters.length + index + 1,
      contentType: SectionContentType.TABLE,
      configuration: {
        kind: "annexure",
        annexureNo: index + 1,
        source: "model-dsr",
        ...context
      }
    }))
  ];
}

function normalizeSections(sections: unknown, context: Record<string, unknown> = {}): NormalizedSection[] {
  if (!Array.isArray(sections) || sections.length === 0) {
    return defaultModelDsrSections(context);
  }

  return sections.map((raw, index) => {
    const section = isRecord(raw) ? raw : {};
    const configuration = isRecord(section.configuration) ? section.configuration : {};
    const sectionName = String(section.sectionName || section.name || `Section ${index + 1}`).trim();

    return {
      sectionName: sectionName || `Section ${index + 1}`,
      sequence: index + 1,
      contentType: contentType(section.contentType),
      configuration: {
        ...configuration,
        ...context
      }
    };
  });
}

async function ensureTemplateSections(modelId: string, context: Record<string, unknown> = {}) {
  const count = await prisma.modelDsrSection.count({ where: { modelId } });
  if (count > 0) return;

  const sections = defaultModelDsrSections(context);
  for (const section of sections) {
    await prisma.modelDsrSection.create({
      data: {
        modelId,
        sectionName: section.sectionName,
        sequence: section.sequence,
        contentType: section.contentType,
        configuration: section.configuration as Prisma.InputJsonObject
      }
    });
  }
}

function splitSections(sections: Array<{ id: string; sectionName: string; sequence: number; contentType: SectionContentType; configuration: Prisma.JsonValue }>) {
  const ordered = [...sections].sort((a, b) => a.sequence - b.sequence);
  return {
    chapters: ordered.filter((section) => !section.sectionName.toLowerCase().includes("annexure")),
    annexures: ordered.filter((section) => section.sectionName.toLowerCase().includes("annexure"))
  };
}

function projectState(projectState?: string | null) {
  if (!projectState) return {};
  try {
    const parsed = JSON.parse(projectState);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// ==========================================
// TEMPLATE MANAGEMENT
// ==========================================

// Get all Model DSR templates
modelDsrRouter.get("/", async (req, res) => {
  const templates = await prisma.modelDsr.findMany({
    orderBy: { createdAt: "desc" },
    include: { sections: { orderBy: { sequence: "asc" } } }
  });
  res.json(jsonSafe(templates));
});

// Create a new Model DSR template
modelDsrRouter.post("/", async (req, res) => {
  try {
    const body = req.body || {};
    const title = String(body.title || "").trim();

    if (!title) {
      res.status(400).json({ error: "Title is required" });
      return;
    }

    const context = {
      district: body.district || null,
      sourceFileName: body.sourceFileName || null
    };
    const sections = normalizeSections(body.sections, context);

    const template = await prisma.modelDsr.create({
      data: {
        title,
        description: body.description ? String(body.description) : null,
        status: ModelDsrStatus.DRAFT,
        createdBy: req.user?.id,
        sections: {
          create: sections.map((section) => ({
            sectionName: section.sectionName,
            sequence: section.sequence,
            contentType: section.contentType,
            configuration: section.configuration as Prisma.InputJsonObject
          }))
        }
      },
      include: { sections: { orderBy: { sequence: "asc" } } }
    });

    res.status(201).json(jsonSafe(template));
  } catch (error: any) {
    if (error?.code === "P2002") {
      res.status(409).json({ error: "A Model DSR with this title already exists" });
      return;
    }
    res.status(500).json({ error: error.message });
  }
});

// Generate Final DSR by merging Payload with Template
modelDsrRouter.post("/generate", async (req, res) => {
  try {
    const { modelId, projectId, dataPayload } = req.body;

    if (!modelId || !dataPayload) {
      res.status(400).json({ error: "modelId and dataPayload are required" });
      return;
    }

    const template = await prisma.modelDsr.findUnique({ where: { id: modelId } });
    if (!template || template.status !== ModelDsrStatus.PUBLISHED) {
      res.status(400).json({ error: "Invalid or unpublished template" });
      return;
    }

    const generated = await prisma.generatedDsr.create({
      data: {
        modelId,
        projectId: projectId ? BigInt(projectId) : null,
        status: GeneratedDsrStatus.FINAL,
        dataPayload: (isRecord(dataPayload) ? dataPayload : {}) as any
      }
    });

    res.json(jsonSafe(generated));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// List Generated DSRs
modelDsrRouter.get("/generated/list", async (req, res) => {
  try {
    const dsrs = await prisma.generatedDsr.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        model: { select: { title: true } }
      }
    });
    res.json(jsonSafe(dsrs));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get a specific Generated DSR
modelDsrRouter.get("/generated/:id", async (req, res) => {
  try {
    const dsr = await prisma.generatedDsr.findUnique({
      where: { id: req.params.id },
      include: {
        model: {
          include: { sections: { orderBy: { sequence: "asc" } } }
        },
        versions: { orderBy: { createdAt: "desc" } }
      }
    });

    if (!dsr) {
      res.status(404).json({ error: "Generated DSR not found" });
      return;
    }

    res.json(jsonSafe(dsr));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get specific Model DSR template with sections
modelDsrRouter.get("/:id", async (req, res) => {
  try {
    const template = await prisma.modelDsr.findUnique({
      where: { id: req.params.id },
      include: {
        sections: {
          orderBy: { sequence: "asc" }
        }
      }
    });

    if (!template) {
      res.status(404).json({ error: "Template not found" });
      return;
    }

    res.json(jsonSafe(template));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Update Model DSR template sections (only if DRAFT)
modelDsrRouter.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body || {};

    const existing = await prisma.modelDsr.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: "Template not found" });
      return;
    }

    if (existing.status === ModelDsrStatus.PUBLISHED) {
      res.status(409).json({ error: "Cannot edit a published template. Create a new version." });
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.modelDsr.update({
        where: { id },
        data: {
          title: body.title ? String(body.title).trim() : existing.title,
          description: body.description !== undefined ? String(body.description || "") : existing.description
        }
      });

      if (Array.isArray(body.sections)) {
        const sections = normalizeSections(body.sections, {
          district: body.district || null,
          sourceFileName: body.sourceFileName || null
        });

        await tx.modelDsrSection.deleteMany({ where: { modelId: id } });
        for (const section of sections) {
          await tx.modelDsrSection.create({
            data: {
              modelId: id,
              sectionName: section.sectionName,
              sequence: section.sequence,
              contentType: section.contentType,
              configuration: section.configuration as Prisma.InputJsonObject
            }
          });
        }
      }
    });

    const finalTemplate = await prisma.modelDsr.findUnique({
      where: { id },
      include: { sections: { orderBy: { sequence: "asc" } } }
    });

    res.json(jsonSafe(finalTemplate));
  } catch (error: any) {
    if (error?.code === "P2002") {
      res.status(409).json({ error: "A Model DSR with this title already exists" });
      return;
    }
    res.status(500).json({ error: error.message });
  }
});

// Publish a Model DSR template
modelDsrRouter.post("/:id/publish", async (req, res) => {
  try {
    const { id } = req.params;
    const template = await prisma.modelDsr.findUnique({
      where: { id },
      include: { sections: true }
    });

    if (!template) {
      res.status(404).json({ error: "Template not found" });
      return;
    }

    if (template.sections.length === 0) {
      await ensureTemplateSections(id);
    }

    const published = await prisma.modelDsr.update({
      where: { id },
      data: { status: ModelDsrStatus.PUBLISHED },
      include: { sections: { orderBy: { sequence: "asc" } } }
    });

    res.json(jsonSafe(published));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Delete/Archive a Model DSR template
modelDsrRouter.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const generatedCount = await prisma.generatedDsr.count({ where: { modelId: id } });

    if (generatedCount > 0) {
      const archived = await prisma.modelDsr.update({
        where: { id },
        data: { status: ModelDsrStatus.ARCHIVED }
      });
      res.json(jsonSafe({ message: "Template archived because it has existing reports", template: archived }));
      return;
    }

    await prisma.modelDsr.delete({ where: { id } });
    res.json(jsonSafe({ message: "Template deleted permanently" }));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// DSR GENERATION & IMPORT
// ==========================================

// Import Model DSR into an Existing Project
modelDsrRouter.post("/:id/import", async (req, res) => {
  try {
    const { id } = req.params;
    const { projectId, config = {} } = req.body || {};

    if (!projectId) {
      res.status(400).json({ error: "projectId is required" });
      return;
    }

    let parsedProjectId: bigint;
    try {
      parsedProjectId = BigInt(projectId);
    } catch {
      res.status(400).json({ error: "Invalid projectId" });
      return;
    }

    await ensureTemplateSections(id);

    const template = await prisma.modelDsr.findUnique({
      where: { id },
      include: { sections: { orderBy: { sequence: "asc" } } }
    });

    if (!template) {
      res.status(404).json({ error: "Model DSR not found" });
      return;
    }

    const project = await prisma.project.findUnique({
      where: { id: parsedProjectId }
    });

    if (!project) {
      res.status(404).json({ error: "Target Project not found" });
      return;
    }

    const state: Record<string, unknown> = projectState(project.projectState);
    const importedAt = new Date().toISOString();
    const { chapters, annexures } = splitSections(template.sections);

    if (config?.backupCurrent) {
      state.__backup = JSON.parse(JSON.stringify(state));
      if (isRecord(state.__backup) && isRecord(state.__backup.__backup)) {
        delete state.__backup.__backup;
      }
    }

    state.modelDsrImported = true;
    state.modelDsrId = template.id;
    state.modelDsrTitle = template.title;
    state.modelDsrImportedAt = importedAt;
    state.modelDsrImportConfig = config;

    if (config?.replaceChapters !== false) {
      state.importedChapters = chapters.map((section) => ({
        id: section.id,
        name: section.sectionName,
        sequence: section.sequence,
        contentType: section.contentType,
        configuration: section.configuration
      }));
      state.chapters = chapters.map((section) => ({
        title: section.sectionName,
        modelDsrSectionId: section.id,
        importedAt
      }));
    }

    if (config?.replaceAnnexures !== false) {
      state.importedAnnexures = annexures.map((section) => ({
        id: section.id,
        name: section.sectionName,
        sequence: section.sequence,
        contentType: section.contentType,
        configuration: section.configuration
      }));
      state.modelDsrAnnexures = annexures.map((section) => ({
        title: section.sectionName,
        modelDsrSectionId: section.id,
        importedAt
      }));
    }

    if (config?.keepAttachments) {
      state.modelDsrKeptExistingAttachments = true;
    }

    await prisma.$transaction(async (tx) => {
      await tx.project.update({
        where: { id: parsedProjectId },
        data: { projectState: JSON.stringify(state) }
      });

      await tx.workflowHistory.create({
        data: {
          reportId: parsedProjectId,
          action: "MODEL_DSR_IMPORTED",
          remarks: `${template.title} imported into ${project.projectName || project.title || "project"}`,
          performedBy: req.user?.id
        }
      });
    });

    res.json(
      jsonSafe({
        message: "Import successful",
        projectId: project.id.toString(),
        modelDsrId: template.id,
        chaptersImported: chapters.length,
        annexuresImported: annexures.length
      })
    );
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

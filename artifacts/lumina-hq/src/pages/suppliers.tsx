import { useState } from "react";
import {
  useGetSuppliers,
  useCreateSupplier,
  useUpdateSupplier,
  useDeactivateSupplier,
  useAddSupplierCategory,
  useRemoveSupplierCategory,
  useGetSupplierPerformance,
  type SupplierWithCategories,
  type SupplierCategoryRecord,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { getGetSuppliersQueryKey } from "@workspace/api-client-react";
import {
  Plus,
  Building2,
  Mail,
  Phone,
  Globe,
  Star,
  Tag,
  X,
  BarChart2,
  Search,
  Edit,
  ChevronRight,
  Clock,
  TrendingUp,
} from "lucide-react";

const CATEGORIES = [
  "Lab Equipment & Instruments",
  "Reagents & Chemicals",
  "Consumables & Plasticware",
  "Glassware",
  "Life Science & Kits",
  "PPE & Safety",
  "Diagnostics",
  "Refrigeration & Storage",
  "Environmental Monitoring",
  "General Lab Supplies",
];

type SupplierFormData = {
  name: string;
  company: string;
  email: string;
  phone: string;
  country: string;
  currency: string;
  typicalLeadTimeDays: string;
  typicalResponseTimeHours: string;
  paymentTerms: string;
  notes: string;
};

export default function Suppliers() {
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showPerf, setShowPerf] = useState<number | null>(null);

  const { data, isLoading } = useGetSuppliers({ includeInactive: showInactive });

  const suppliers = data?.suppliers ?? [];
  const filtered = suppliers.filter((s) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      s.company.toLowerCase().includes(q) ||
      s.name.toLowerCase().includes(q) ||
      s.email.toLowerCase().includes(q) ||
      s.categories.some((c) => c.category.toLowerCase().includes(q))
    );
  });

  const selected = filtered.find((s) => s.id === selectedId) ?? null;

  return (
    <div className="h-full flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Supplier Database</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {suppliers.length} supplier{suppliers.length !== 1 ? "s" : ""}
            {!showInactive && " (active)"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground"
            onClick={() => setShowInactive((v) => !v)}
          >
            {showInactive ? "Hide inactive" : "Show inactive"}
          </Button>
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="w-4 h-4 mr-1.5" /> Add Supplier
          </Button>
        </div>
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          className="pl-9 h-9"
          placeholder="Search by name, company, category…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 w-full rounded-lg" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Building2 className="w-10 h-10 text-muted-foreground/30 mb-3" />
          <p className="text-muted-foreground font-medium">No suppliers found</p>
          <p className="text-muted-foreground/60 text-sm mt-1">
            {search ? "Try a different search term" : "Add your first supplier to get started"}
          </p>
          {!search && (
            <Button size="sm" className="mt-4" onClick={() => setShowCreate(true)}>
              <Plus className="w-4 h-4 mr-1.5" /> Add Supplier
            </Button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3">
          {filtered.map((supplier) => (
            <SupplierRow
              key={supplier.id}
              supplier={supplier}
              isSelected={selectedId === supplier.id}
              onSelect={() => setSelectedId(selectedId === supplier.id ? null : supplier.id)}
              onEdit={() => setSelectedId(supplier.id)}
              onShowPerf={() => setShowPerf(supplier.id)}
            />
          ))}
        </div>
      )}

      {/* Supplier detail panel */}
      {selected && (
        <SupplierDetailPanel
          supplier={selected}
          onClose={() => setSelectedId(null)}
        />
      )}

      {/* Create modal */}
      <CreateSupplierModal isOpen={showCreate} onClose={() => setShowCreate(false)} />

      {/* Performance modal */}
      {showPerf !== null && (
        <PerformanceModal supplierId={showPerf} supplierName={suppliers.find(s => s.id === showPerf)?.company ?? ""} onClose={() => setShowPerf(null)} />
      )}
    </div>
  );
}

function SupplierRow({
  supplier,
  isSelected,
  onSelect,
  onShowPerf,
}: {
  supplier: SupplierWithCategories;
  isSelected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onShowPerf: () => void;
}) {
  return (
    <Card
      className={`cursor-pointer transition-colors ${isSelected ? "ring-1 ring-primary" : "hover:bg-muted/30"}`}
      onClick={onSelect}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-sm">{supplier.company}</span>
              {!supplier.isActive && (
                <Badge variant="secondary" className="text-[9px] h-4 px-1.5">Inactive</Badge>
              )}
              {supplier.categories.some((c) => c.isPreferred) && (
                <Badge className="text-[9px] h-4 px-1.5 bg-amber-500/10 text-amber-500 border-amber-500/20">
                  <Star className="w-2.5 h-2.5 mr-0.5" /> Preferred
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">{supplier.name}</p>
            <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground flex-wrap">
              <span className="flex items-center gap-1">
                <Mail className="w-3 h-3" /> {supplier.email}
              </span>
              {supplier.phone && (
                <span className="flex items-center gap-1">
                  <Phone className="w-3 h-3" /> {supplier.phone}
                </span>
              )}
              <span className="flex items-center gap-1">
                <Globe className="w-3 h-3" /> {supplier.country} · {supplier.currency}
              </span>
              {supplier.typicalLeadTimeDays && (
                <span className="flex items-center gap-1">
                  <Clock className="w-3 h-3" /> {supplier.typicalLeadTimeDays}d lead
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={(e) => { e.stopPropagation(); onShowPerf(); }}
            >
              <BarChart2 className="w-3.5 h-3.5" />
            </Button>
            <ChevronRight className={`w-4 h-4 text-muted-foreground transition-transform ${isSelected ? "rotate-90" : ""}`} />
          </div>
        </div>

        {/* Categories */}
        {supplier.categories.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-3">
            {supplier.categories.map((cat) => (
              <Badge
                key={cat.id}
                variant="outline"
                className={`text-[10px] h-5 px-2 ${cat.isPreferred ? "border-primary/30 text-primary" : ""}`}
              >
                {cat.isPreferred && <Star className="w-2.5 h-2.5 mr-1" />}
                {cat.category}
              </Badge>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SupplierDetailPanel({
  supplier,
  onClose,
}: {
  supplier: SupplierWithCategories;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const updateSupplier = useUpdateSupplier();
  const deactivate = useDeactivateSupplier();
  const addCategory = useAddSupplierCategory();
  const removeCategory = useRemoveSupplierCategory();
  const [newCat, setNewCat] = useState("");
  const [editingNotes, setEditingNotes] = useState(false);
  const [notes, setNotes] = useState(supplier.notes ?? "");

  const invalidate = () => qc.invalidateQueries({ queryKey: getGetSuppliersQueryKey() });

  const handleAddCategory = () => {
    if (!newCat) return;
    addCategory.mutate(
      { id: supplier.id, data: { category: newCat } },
      {
        onSuccess: () => { invalidate(); setNewCat(""); toast.success("Category added"); },
        onError: () => toast.error("Failed to add category"),
      },
    );
  };

  const handleRemoveCategory = (catId: number) => {
    removeCategory.mutate(
      { id: supplier.id, catId },
      {
        onSuccess: () => { invalidate(); toast.success("Category removed"); },
        onError: () => toast.error("Failed to remove category"),
      },
    );
  };

  const handleSaveNotes = () => {
    updateSupplier.mutate(
      { id: supplier.id, data: { notes } },
      {
        onSuccess: () => { invalidate(); setEditingNotes(false); toast.success("Notes saved"); },
        onError: () => toast.error("Failed to save notes"),
      },
    );
  };

  const handleDeactivate = () => {
    deactivate.mutate(
      { id: supplier.id },
      {
        onSuccess: () => { invalidate(); onClose(); toast.success("Supplier deactivated"); },
        onError: () => toast.error("Failed to deactivate"),
      },
    );
  };

  return (
    <Card className="border-primary/20 bg-primary/3">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-base">{supplier.company}</CardTitle>
            <CardDescription>{supplier.name} · {supplier.email}</CardDescription>
          </div>
          <Button variant="ghost" size="icon" className="h-7 w-7 -mr-1 -mt-1" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Meta */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          {[
            { label: "Country", value: supplier.country },
            { label: "Currency", value: supplier.currency },
            { label: "Lead Time", value: supplier.typicalLeadTimeDays ? `${supplier.typicalLeadTimeDays} days` : "—" },
            { label: "Response Time", value: supplier.typicalResponseTimeHours ? `${supplier.typicalResponseTimeHours}h` : "—" },
          ].map((item) => (
            <div key={item.label}>
              <div className="text-xs text-muted-foreground mb-0.5">{item.label}</div>
              <div className="font-medium">{item.value}</div>
            </div>
          ))}
        </div>

        {supplier.paymentTerms && (
          <div className="text-sm">
            <div className="text-xs text-muted-foreground mb-0.5">Payment Terms</div>
            <div className="font-medium">{supplier.paymentTerms}</div>
          </div>
        )}

        {/* Categories */}
        <div>
          <div className="text-xs text-muted-foreground mb-2">Product Categories</div>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {supplier.categories.map((cat) => (
              <Badge key={cat.id} variant="outline" className="text-xs gap-1.5 pr-1 pl-2">
                {cat.category}
                <button
                  onClick={() => handleRemoveCategory(cat.id)}
                  className="hover:text-destructive transition-colors"
                >
                  <X className="w-3 h-3" />
                </button>
              </Badge>
            ))}
          </div>
          <div className="flex gap-2">
            <Select value={newCat} onValueChange={setNewCat}>
              <SelectTrigger className="h-8 text-xs flex-1">
                <SelectValue placeholder="Add category…" />
              </SelectTrigger>
              <SelectContent>
                {CATEGORIES.filter(
                  (c) => !supplier.categories.some((sc) => sc.category === c),
                ).map((c) => (
                  <SelectItem key={c} value={c} className="text-xs">
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" className="h-8 text-xs" onClick={handleAddCategory} disabled={!newCat}>
              <Tag className="w-3.5 h-3.5 mr-1" /> Add
            </Button>
          </div>
        </div>

        {/* Notes */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <div className="text-xs text-muted-foreground">Notes</div>
            {!editingNotes && (
              <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setEditingNotes(true)}>
                <Edit className="w-3 h-3 mr-1" /> Edit
              </Button>
            )}
          </div>
          {editingNotes ? (
            <div className="space-y-2">
              <Textarea
                className="text-xs min-h-[60px]"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Add internal notes about this supplier…"
              />
              <div className="flex gap-2">
                <Button size="sm" className="h-7 text-xs" onClick={handleSaveNotes}>Save</Button>
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setEditingNotes(false); setNotes(supplier.notes ?? ""); }}>Cancel</Button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {supplier.notes || <span className="italic opacity-50">No notes</span>}
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 pt-2 border-t border-border">
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs text-destructive border-destructive/20 hover:bg-destructive/5"
            onClick={handleDeactivate}
            disabled={!supplier.isActive}
          >
            {supplier.isActive ? "Deactivate" : "Already inactive"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function CreateSupplierModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const create = useCreateSupplier();
  const [categories, setCategories] = useState<string[]>([]);
  const [newCat, setNewCat] = useState("");

  const form = useForm<SupplierFormData>({
    defaultValues: {
      name: "",
      company: "",
      email: "",
      phone: "",
      country: "SA",
      currency: "SAR",
      typicalLeadTimeDays: "",
      typicalResponseTimeHours: "",
      paymentTerms: "Net 30",
      notes: "",
    },
  });

  const onSubmit = (values: SupplierFormData) => {
    create.mutate(
      {
        data: {
          name: values.name,
          company: values.company,
          email: values.email,
          phone: values.phone || undefined,
          country: values.country,
          currency: values.currency,
          typicalLeadTimeDays: values.typicalLeadTimeDays ? parseInt(values.typicalLeadTimeDays) : undefined,
          typicalResponseTimeHours: values.typicalResponseTimeHours ? parseInt(values.typicalResponseTimeHours) : undefined,
          paymentTerms: values.paymentTerms || undefined,
          notes: values.notes || undefined,
          categories: categories.map((c) => ({ category: c })),
        },
      },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getGetSuppliersQueryKey() });
          toast.success("Supplier created");
          form.reset();
          setCategories([]);
          onClose();
        },
        onError: () => toast.error("Failed to create supplier"),
      },
    );
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Add Supplier</DialogTitle>
          <DialogDescription>Add a new supplier to your database.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4 overflow-y-auto flex-1 pr-1">
            <div className="grid grid-cols-2 gap-3">
              <FormField control={form.control} name="company" render={({ field }) => (
                <FormItem>
                  <FormLabel>Company Name *</FormLabel>
                  <FormControl><Input {...field} placeholder="e.g. Sigma-Aldrich ME" required /></FormControl>
                </FormItem>
              )} />
              <FormField control={form.control} name="name" render={({ field }) => (
                <FormItem>
                  <FormLabel>Contact Name *</FormLabel>
                  <FormControl><Input {...field} placeholder="e.g. Ahmed Al-Rashid" required /></FormControl>
                </FormItem>
              )} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <FormField control={form.control} name="email" render={({ field }) => (
                <FormItem>
                  <FormLabel>Email *</FormLabel>
                  <FormControl><Input {...field} type="email" placeholder="supplier@example.com" required /></FormControl>
                </FormItem>
              )} />
              <FormField control={form.control} name="phone" render={({ field }) => (
                <FormItem>
                  <FormLabel>Phone</FormLabel>
                  <FormControl><Input {...field} placeholder="+966 …" /></FormControl>
                </FormItem>
              )} />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <FormField control={form.control} name="country" render={({ field }) => (
                <FormItem>
                  <FormLabel>Country</FormLabel>
                  <FormControl><Input {...field} placeholder="SA" /></FormControl>
                </FormItem>
              )} />
              <FormField control={form.control} name="currency" render={({ field }) => (
                <FormItem>
                  <FormLabel>Currency</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {["SAR", "USD", "EUR", "GBP", "AED"].map((c) => (
                        <SelectItem key={c} value={c}>{c}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormItem>
              )} />
              <FormField control={form.control} name="paymentTerms" render={({ field }) => (
                <FormItem>
                  <FormLabel>Payment Terms</FormLabel>
                  <FormControl><Input {...field} placeholder="Net 30" /></FormControl>
                </FormItem>
              )} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <FormField control={form.control} name="typicalLeadTimeDays" render={({ field }) => (
                <FormItem>
                  <FormLabel>Typical Lead Time (days)</FormLabel>
                  <FormControl><Input {...field} type="number" min="1" placeholder="14" /></FormControl>
                </FormItem>
              )} />
              <FormField control={form.control} name="typicalResponseTimeHours" render={({ field }) => (
                <FormItem>
                  <FormLabel>Response Time (hours)</FormLabel>
                  <FormControl><Input {...field} type="number" min="1" placeholder="24" /></FormControl>
                </FormItem>
              )} />
            </div>

            {/* Categories */}
            <div>
              <div className="text-sm font-medium mb-2">Product Categories</div>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {categories.map((c) => (
                  <Badge key={c} variant="outline" className="text-xs gap-1.5 pr-1 pl-2">
                    {c}
                    <button type="button" onClick={() => setCategories((prev) => prev.filter((x) => x !== c))}>
                      <X className="w-3 h-3" />
                    </button>
                  </Badge>
                ))}
              </div>
              <div className="flex gap-2">
                <Select value={newCat} onValueChange={setNewCat}>
                  <SelectTrigger className="h-8 text-xs flex-1">
                    <SelectValue placeholder="Select category…" />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.filter((c) => !categories.includes(c)).map((c) => (
                      <SelectItem key={c} value={c} className="text-xs">{c}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                  onClick={() => { if (newCat && !categories.includes(newCat)) { setCategories((p) => [...p, newCat]); setNewCat(""); } }}
                  disabled={!newCat}
                >
                  Add
                </Button>
              </div>
            </div>

            <FormField control={form.control} name="notes" render={({ field }) => (
              <FormItem>
                <FormLabel>Notes</FormLabel>
                <FormControl>
                  <Textarea {...field} placeholder="Internal notes about this supplier…" className="min-h-[60px] text-sm" />
                </FormControl>
              </FormItem>
            )} />

            <DialogFooter className="pt-2 shrink-0">
              <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? "Creating…" : "Create Supplier"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function PerformanceModal({ supplierId, supplierName, onClose }: { supplierId: number; supplierName: string; onClose: () => void }) {
  const { data, isLoading } = useGetSupplierPerformance(supplierId);

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TrendingUp className="w-4 h-4" /> Performance — {supplierName}
          </DialogTitle>
          <DialogDescription>Historical RFQ engagement metrics</DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : data ? (
          <div className="grid grid-cols-2 gap-4">
            {[
              { label: "Total RFQs", value: data.performance.totalRfqs },
              { label: "Contacted", value: data.performance.totalContacted },
              { label: "Responded", value: data.performance.totalResponded },
              { label: "Selected", value: data.performance.totalSelected },
              { label: "Response Rate", value: `${data.performance.responseRatePercent}%` },
              { label: "Selection Rate", value: `${data.performance.selectionRatePercent}%` },
              {
                label: "Avg Response Time",
                value: data.performance.avgResponseTimeHours
                  ? `${data.performance.avgResponseTimeHours}h`
                  : "—",
              },
            ].map((item) => (
              <div key={item.label} className="bg-muted/40 rounded-lg p-3">
                <div className="text-xs text-muted-foreground mb-1">{item.label}</div>
                <div className="text-xl font-bold font-mono">{item.value}</div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground text-center py-4">No performance data yet</p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

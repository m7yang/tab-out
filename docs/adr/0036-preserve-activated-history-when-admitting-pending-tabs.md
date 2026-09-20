# Preserve activated history when admitting pending tabs

The Activation History panel displays indexed rows by distance from its current
position. Admitting rows in that same order let a pending `+1` claim a page
identity before an activated `-2`. Opening a background link could therefore
hide an existing activated target despite spare capacity and an unchanged
navigation stack.

Choose activated page representatives first, keeping the closest activated
entry for each page identity. Admit pending physical tabs next without merging
them, then admit non-overlapping Working Set and recently closed rows. This
also preserves the existing priority for the bounded row budget.

Admission priority does not change presentation: compute indexed timestamps
in cursor-distance order before admission, and use them for the final merged
display. Keep the original navigation indexes. Changing to a signed sort or
renumbering visible rows would change the established navigation presentation
without addressing the cause of the suppression.

Regression coverage checks matching pending tabs on either side of the
activated admission order, normalized page identities, filtering, supplemental
deduplication, and the shared row budget.
